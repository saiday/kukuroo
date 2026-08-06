// The HTTP surface, exercised through the real route set: routing, both gates,
// the fan-out, and CORS. The crypto has its own file; this one is about the
// contract a deployment actually speaks. If this fails, an enrolment page or a
// sender somewhere sees behaviour the README does not describe.
import { mountKukuroo } from "../src/mount.ts";

const ok = (label, cond) => {
  console.log(`${cond ? "  ok" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// Capture console.error: some paths are *supposed* to say something, and the
// assertions below check that they do, exactly once where once is the point.
const errors = [];
const realConsoleError = console.error;
console.error = (...parts) => errors.push(parts.join(" "));

// A minimal in-memory KV double.
function fakeKV() {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, v); },
    async get(k) { return store.get(k) ?? null; },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// Real keys, so nothing has to be stubbed below the HTTP layer.
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidJwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const subscriptionBody = () => ({
  endpoint: "https://web.push.apple.com/QAbc123",
  keys: { p256dh: b64url(uaPublic), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) },
});

const kv = fakeKV();
const env = {
  KUKUROO_SUBS: kv,
  KUKUROO_VAPID_PRIVATE: JSON.stringify({ kty: "EC", crv: "P-256", d: vapidJwk.d, x: vapidJwk.x, y: vapidJwk.y }),
  KUKUROO_SEND_TOKEN: "token-token-token",
  KUKUROO_INVITE_CODE: "invite-invite",
};

const kukuroo = mountKukuroo({ prefix: "/push", standalone: true });
const req = (path, init) => new Request("https://push.example.com" + path, init);

// ---- routing ---------------------------------------------------------------
ok("outside the prefix returns null", (await kukuroo.handle(req("/other"), env)) === null);
ok("GET /push/enroll is 200", (await kukuroo.handle(req("/push/enroll"), env)).status === 200);
ok("GET /push/public-key is 200", (await kukuroo.handle(req("/push/public-key"), env)).status === 200);
ok("unknown route under the prefix is 404", (await kukuroo.handle(req("/push/nope"), env)).status === 404);

// ---- gates -----------------------------------------------------------------
const wrongInvite = await kukuroo.handle(req("/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ invite: "wrong", subscription: subscriptionBody() }),
}), env);
ok("subscribe with the wrong invite is 403", wrongInvite.status === 403);

const enrolled = await kukuroo.handle(req("/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ invite: "invite-invite", subscription: subscriptionBody(), label: "iPhone" }),
}), env);
ok("subscribe with the right invite is 200", enrolled.status === 200);
ok("the subscription landed in KV", kv.store.size === 1);

ok("send without a bearer token is 401",
  (await kukuroo.handle(req("/push/send", { method: "POST", body: "{}" }), env)).status === 401);

// ---- the fan-out, push service stubbed -------------------------------------
const pushed = [];
globalThis.fetch = async (url, init) => { pushed.push({ url, init }); return new Response(null, { status: 201 }); };
const sendResponse = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), env);
const sendResult = await sendResponse.json();
ok("send fans out to the stored subscription", sendResult.delivered === 1 && pushed.length === 1);
ok("the push POST carries VAPID auth and aes128gcm",
  pushed[0].init.headers.Authorization.startsWith("vapid t=") &&
  pushed[0].init.headers["Content-Encoding"] === "aes128gcm");

// ---- CORS off (the default) ------------------------------------------------
const noCorsPreflight = await kukuroo.handle(req("/push/subscribe", {
  method: "OPTIONS",
  headers: { origin: "https://www.example.com", "access-control-request-method": "POST" },
}), env);
const noCorsBody = await noCorsPreflight.json();
ok("with no allowed origins, a real preflight is told CORS is off",
  noCorsPreflight.status === 403 && noCorsBody.error.includes("not enabled"));
ok("a bare OPTIONS with no preflight headers stays a plain 405",
  (await kukuroo.handle(req("/push/subscribe", { method: "OPTIONS" }), env)).status === 405);
const bareKey = await kukuroo.handle(req("/push/public-key", { headers: { origin: "https://www.example.com" } }), env);
ok("with no allowed origins, no CORS header is emitted",
  bareKey.headers.get("access-control-allow-origin") === null);

// ---- CORS on ---------------------------------------------------------------
// One good entry, one that normalises (default port, trailing slash), one junk.
const corsEnv = {
  ...env,
  KUKUROO_ALLOWED_ORIGINS: "https://www.example.com, https://blog.example.com:443/, junk",
};
const SITE = "https://www.example.com";

const preflight = await kukuroo.handle(req("/push/subscribe", {
  method: "OPTIONS",
  headers: { origin: SITE, "access-control-request-method": "POST" },
}), corsEnv);
ok("an allowed origin's preflight is 204", preflight.status === 204);
ok("the preflight echoes the one origin, not a wildcard",
  preflight.headers.get("access-control-allow-origin") === SITE);
ok("the preflight allows POST and content-type",
  preflight.headers.get("access-control-allow-methods") === "POST" &&
  preflight.headers.get("access-control-allow-headers") === "content-type");

const normalised = await kukuroo.handle(req("/push/public-key", {
  headers: { origin: "https://blog.example.com" },
}), corsEnv);
ok("an entry with a default port and slash still matches its origin",
  normalised.headers.get("access-control-allow-origin") === "https://blog.example.com");

ok("the junk entry was reported, once, not silently dropped",
  errors.filter((e) => e.includes("KUKUROO_ALLOWED_ORIGINS") && e.includes("junk")).length === 1);

const denied = await kukuroo.handle(req("/push/subscribe", {
  method: "OPTIONS",
  headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
}), corsEnv);
const deniedBody = await denied.json();
ok("a disallowed origin's preflight is 403 and names the variable",
  denied.status === 403 && deniedBody.error.includes("KUKUROO_ALLOWED_ORIGINS"));

const corsWrongInvite = await kukuroo.handle(req("/push/subscribe", {
  method: "POST",
  headers: { origin: SITE, "content-type": "application/json" },
  body: JSON.stringify({ invite: "wrong", subscription: subscriptionBody() }),
}), corsEnv);
ok("even a 403 carries the CORS header, so the page can read the error",
  corsWrongInvite.status === 403 &&
  corsWrongInvite.headers.get("access-control-allow-origin") === SITE);

const corsSend = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { origin: SITE, authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), corsEnv);
ok("send never gets a CORS header, even for an allowed origin",
  corsSend.headers.get("access-control-allow-origin") === null);

// ---- missing configuration, the two failure shapes ---------------------------
const envNoSecret = { ...env };
delete envNoSecret.KUKUROO_INVITE_CODE;
ok("a missing secret returns the friendly 503",
  (await kukuroo.handle(req("/push/subscribe", { method: "POST", body: "{}" }), envNoSecret)).status === 503);

const envNoKV = { ...env };
delete envNoKV.KUKUROO_SUBS;
let threw = false;
try {
  await kukuroo.handle(req("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ invite: "invite-invite", subscription: subscriptionBody() }),
  }), envNoKV);
} catch { threw = true; }
ok("a missing KV binding still throws (the host's opaque 500; see mount.ts)", threw);

console.error = realConsoleError;
