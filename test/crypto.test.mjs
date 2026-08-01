// Round-trip the RFC 8291 encryption and the RFC 8292 token against Node's
// Web Crypto, playing the part of the user agent. If this fails, the phone
// would have shown nothing and said nothing.
import { encryptPayload } from "../src/encrypt.ts";
import { importVapidKeys, signVapidToken } from "../src/vapid.ts";
import { buildDeclarativePayload } from "../src/payload.ts";
import { b64urlEncode, b64urlDecode, concat, utf8 } from "../src/bytes.ts";

const ok = (label, cond) => {
  console.log(`${cond ? "  ok" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// ---- the device side -------------------------------------------------------
const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const subKeys = { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(authSecret) };

// ---- encrypt ---------------------------------------------------------------
const json = buildDeclarativePayload({
  notification: { title: "hello", navigate: "https://push.example.com/", tag: "t" },
  appBadge: 3,
});
ok("app_badge emitted in both positions", JSON.parse(json).app_badge === 3 && JSON.parse(json).notification.app_badge === 3);
ok("web_push is exactly 8030", JSON.parse(json).web_push === 8030);

const body = await encryptPayload(utf8(json), subKeys);

// ---- decrypt, as the user agent would --------------------------------------
const salt = body.slice(0, 16);
const idlen = body[20];
const asPublic = body.slice(21, 21 + idlen);
const ciphertext = body.slice(21 + idlen);
ok("key id length is 65", idlen === 65);

const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
const prkKey = await hmac(authSecret, shared);
const ikm = await hmac(prkKey, concat(utf8("WebPush: info"), [0], uaPublic, asPublic, [1]));
const prk = await hmac(salt, ikm);
const cek = (await hmac(prk, concat(utf8("Content-Encoding: aes128gcm"), [0, 1]))).slice(0, 16);
const nonce = (await hmac(prk, concat(utf8("Content-Encoding: nonce"), [0, 1]))).slice(0, 12);
const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);

const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, ciphertext));
ok("padding delimiter is 0x02 (last record)", plain[plain.length - 1] === 0x02);
ok("plaintext round-trips", new TextDecoder().decode(plain.slice(0, -1)) === json);

// ---- VAPID -----------------------------------------------------------------
const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPublic = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)));
const vapidJwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);

for (const [label, material] of [
  ["raw 32-byte d", b64urlEncode(b64urlDecode(vapidJwk.d))],
  ["JWK json", JSON.stringify(vapidJwk)],
  ["pkcs8", b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", vapid.privateKey)))],
]) {
  const { privateKey: key } = await importVapidKeys(material, vapidPublic);
  const token = await signVapidToken(key, "https://web.push.apple.com", "https://push.example.com");
  const [h, p, s] = token.split(".");
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, vapid.publicKey, b64urlDecode(s), utf8(h + "." + p),
  );
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  ok(`VAPID import (${label}) signs a verifiable ES256 token`, verified);
  ok(`VAPID aud is the endpoint origin (${label})`, claims.aud === "https://web.push.apple.com");
}

// ---- deriving the public key, so it need not be configured -----------------
for (const [label, material] of [
  ["JWK", JSON.stringify(vapidJwk)],
  ["pkcs8", b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", vapid.privateKey)))],
]) {
  const derived = await importVapidKeys(material);
  ok(`public key derived from ${label} with nothing configured`, derived.publicKeyB64 === vapidPublic);
}

let scalarThrew = false;
try {
  await importVapidKeys(b64urlEncode(b64urlDecode(vapidJwk.d)));
} catch {
  scalarThrew = true;
}
ok("bare scalar with no public key is rejected, not guessed at", scalarThrew);

// ---- the mismatch guard ----------------------------------------------------
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const otherJwk = await crypto.subtle.exportKey("jwk", other.privateKey);
let threw = false;
try { await importVapidKeys(JSON.stringify(otherJwk), vapidPublic); } catch { threw = true; }
ok("mismatched keypair is rejected loudly", threw);

// ---- the validators --------------------------------------------------------
const rejects = async (label, opts) => {
  let t = false;
  try { buildDeclarativePayload(opts); } catch { t = true; }
  ok(label, t);
};
await rejects("relative navigate rejected", { notification: { title: "a", navigate: "/w/x" } });
await rejects("invalid icon rejected", { notification: { title: "a", navigate: "https://x.test/", icon: "notaurl" } });
await rejects("missing title rejected", { notification: { navigate: "https://x.test/" } });
await rejects("WebKit-ignored field rejected", { notification: { title: "a", navigate: "https://x.test/", actions: [] } });
await rejects("oversize payload rejected", { notification: { title: "a", navigate: "https://x.test/", body: "x".repeat(4000) } });
