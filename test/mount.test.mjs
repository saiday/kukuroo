// The HTTP surface, exercised through the real route set: routing, both gates,
// the fan-out, and CORS. The crypto has its own file; this one is about the
// contract a deployment actually speaks. If this fails, an enrollment page or a
// sender somewhere sees behaviour the README does not describe.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// The prefix is operator-typed, and both ways of typing it slightly wrong used
// to fail silently in opposite directions: no leading slash matched nothing and
// unmounted every route, while "/" matched everything and answered the host
// Worker's own pages with Kukuroo's 404.
const noSlash = mountKukuroo({ prefix: "push", standalone: true });
ok("a prefix with no leading slash still mounts the routes",
  (await noSlash.handle(req("/push/public-key"), env)).status === 200);
const rootMounted = mountKukuroo({ prefix: "/", standalone: true });
ok("mounted at the root, our own routes still answer",
  (await rootMounted.handle(req("/public-key"), env)).status === 200);
ok("mounted at the root, the host's routes fall through instead of 404",
  (await rootMounted.handle(req("/anything-of-the-hosts"), env)) === null);

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
const vapidRawPub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey)));
ok("the k= parameter is the sender's uncompressed public key",
  pushed[0].init.headers.Authorization.endsWith(`k=${vapidRawPub}`));

const badSubject = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), { ...env, KUKUROO_VAPID_SUBJECT: "saiday@example.com" });
// 503, not 400: the subject is an operator's environment variable, and a caller
// holding the send token cannot fix it by rewriting its notification.
ok("a bare-email VAPID subject is refused by name, once, before the fan-out",
  badSubject.status === 503 && (await badSubject.json()).error.includes("KUKUROO_VAPID_SUBJECT"));

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

// ---- bodies that parse but are not objects ----------------------------------
// `JSON.parse("null")` succeeds and `typeof null === "object"`, so this reached
// the field reads and threw out of handle() as an unhandled exception.
const nullBody = await kukuroo.handle(req("/push/subscribe", { method: "POST", body: "null" }), env);
ok("a null body is a 400, not an exception out of handle()",
  nullBody.status === 400 && (await nullBody.json()).error.includes("JSON object"));
const arrayBody = await kukuroo.handle(req("/push/subscribe", { method: "POST", body: "[]" }), env);
ok("an array body is a 400 too", arrayBody.status === 400);

// ---- subscriptions that could never be encrypted for -------------------------
// Stored, these are a device that is told "enrolled" and then silently receives
// nothing forever, counting as a failure on every send.
const shortKeys = await kukuroo.handle(req("/push/subscribe", {
  method: "POST",
  body: JSON.stringify({
    invite: "invite-invite",
    subscription: { endpoint: "https://web.push.apple.com/x", keys: { p256dh: "AAAA", auth: "AA" } },
  }),
}), env);
ok("key material that cannot decrypt is refused at enrollment, not at send time",
  shortKeys.status === 400 && (await shortKeys.json()).error.includes("p256dh"));

// ---- caller fields that go straight into headers -----------------------------
const badTtl = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ ttl: 1e21, notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), env);
ok("a malformed ttl is one 400, not a 200 carrying delivered: 0",
  badTtl.status === 400 && (await badTtl.json()).error.includes("ttl"));
const badTopic = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ topic: "x".repeat(33), notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), env);
ok("a malformed topic is refused the same way", badTopic.status === 400);

// ---- notification members WebKit type-checks --------------------------------
// A type mismatch makes WebKit discard the whole payload and display nothing,
// so these are not smaller mistakes than a missing title.
const badBody = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://push.example.com/", body: 42 } }),
}), env);
ok("a numeric notification.body is a 400 rather than a silent non-display",
  badBody.status === 400 && (await badBody.json()).error.includes("notification.body"));

// ---- the navigate-origin policy, as an operator would type it ----------------
// A trailing slash is what a browser address bar hands you, and comparing it
// raw rejected every notification a correctly-configured deployment could send.
const slashOrigin = { ...env, KUKUROO_NAVIGATE_ORIGIN: "https://push.example.com/" };
const sameOrigin = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), slashOrigin);
ok("a trailing slash on KUKUROO_NAVIGATE_ORIGIN still matches its own origin",
  sameOrigin.status === 200);
const offOrigin = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://elsewhere.example/" } }),
}), slashOrigin);
ok("and a genuinely off-origin navigate is still refused", offOrigin.status === 400);

// ---- missing configuration -------------------------------------------------
// Every unconfigured binding answers the same way: a 503 that names the thing
// to go and set. A string secret and a KV namespace are equally easy to skip,
// and the operator who skipped one is not helped by learning that the other
// kind gets a sentence while theirs gets Cloudflare's 1101 page.
const envNoSecret = { ...env };
delete envNoSecret.KUKUROO_INVITE_CODE;
ok("a missing secret returns the friendly 503",
  (await kukuroo.handle(req("/push/subscribe", { method: "POST", body: "{}" }), envNoSecret)).status === 503);

const envNoKV = { ...env };
delete envNoKV.KUKUROO_SUBS;
const noKV = await kukuroo.handle(req("/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ invite: "invite-invite", subscription: subscriptionBody() }),
}), envNoKV);
ok("a missing KV binding returns a 503 naming the binding",
  noKV.status === 503 && (await noKV.json()).error.includes("KUKUROO_SUBS"));

const noKVSend = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), envNoKV);
ok("send says the same thing rather than blaming the caller's body",
  noKVSend.status === 503 && (await noKVSend.json()).error.includes("KUKUROO_SUBS"));

const envNoVapid = { ...env };
delete envNoVapid.KUKUROO_VAPID_PRIVATE;
const noVapidSend = await kukuroo.handle(req("/push/send", {
  method: "POST",
  headers: { authorization: "Bearer token-token-token" },
  body: JSON.stringify({ notification: { title: "hi", navigate: "https://push.example.com/" } }),
}), envNoVapid);
ok("a missing VAPID key is a 503 on send that names the variable",
  noVapidSend.status === 503 && (await noVapidSend.json()).error.includes("KUKUROO_VAPID_PRIVATE"));

// The route the enrollment page fetches, so this is where a skipped setup step
// is actually met: on a phone, by somebody who did not configure the Worker.
// It used to answer "the VAPID key on this Worker is not usable", which is what
// a corrupt key says too, leaving the operator to guess which of the two it was.
const noVapidKey = await kukuroo.handle(req("/push/public-key"), envNoVapid);
const noVapidKeyBody = await noVapidKey.json();
ok("public-key says the same thing, and names the same variable",
  noVapidKey.status === 503 && noVapidKeyBody.error.includes("KUKUROO_VAPID_PRIVATE"));

// A key that is present and broken must stay distinguishable from one that is
// absent; collapsing the two is the bug above in the other direction.
const badVapid = await kukuroo.handle(req("/push/public-key"),
  { ...env, KUKUROO_VAPID_PRIVATE: "not-a-key" });
ok("a present but unusable key still reports as unusable, not as missing",
  badVapid.status === 503 && !(await badVapid.json()).error.includes("is not configured"));

// ---- the gate opened on purpose ---------------------------------------------
// `requireInvite: false` is the answer to "is this deployment personal?". It has
// its own KV so the fan-out counts above stay about the subscription they were
// written for.
const openKv = fakeKV();
const openEnv = { ...env, KUKUROO_SUBS: openKv };
const openKukuroo = mountKukuroo({ prefix: "/push", standalone: true, requireInvite: false });

const noInvite = await openKukuroo.handle(req("/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ subscription: subscriptionBody(), label: "iPhone" }),
}), openEnv);
ok("with the gate open, a body carrying no invite is 200",
  noInvite.status === 200 && openKv.store.size === 1);

const staleInvite = await openKukuroo.handle(req("/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ invite: "whatever", subscription: subscriptionBody() }),
}), openEnv);
ok("a stale invite is ignored rather than checked", staleInvite.status === 200);

const openEnvNoSecret = { ...openEnv };
delete openEnvNoSecret.KUKUROO_INVITE_CODE;
ok("with the gate open, the missing secret is not consulted and not a 503",
  (await openKukuroo.handle(req("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: subscriptionBody() }),
  }), openEnvNoSecret)).status === 200);

const openPage = await (await openKukuroo.handle(req("/push/enroll"), openEnv)).text();
ok("the open enrollment page has no code field to type into", !openPage.includes('id="invite"'));
const gatedPage = await (await kukuroo.handle(req("/push/enroll"), env)).text();
ok("the gated enrollment page still asks for one", gatedPage.includes('id="invite"'));

// What iOS writes under the Home Screen icon. It is read every day after
// enrollment, on a screen beside other apps, so it has to name the deployment
// rather than describe the one-off act of enrolling. The heading is the opposite
// case and stays an instruction, which is why these are two values and not one.
ok("the document title is the deployment's own name",
  gatedPage.includes("<title>push</title>"));
ok("the Home Screen name is the same",
  gatedPage.includes('<meta name="apple-mobile-web-app-title" content="push">'));
ok("the heading is still the instruction, not the name",
  gatedPage.includes('<h1 id="heading">Enroll this device</h1>'));

const wdPage = await (await kukuroo.handle(
  new Request("https://kukuroo-qa.acct.workers.dev/push/enroll"), env)).text();
ok("a workers.dev deployment is named after the Worker, not the account",
  wdPage.includes("<title>kukuroo-qa</title>"));

// An IP is not a name, and "192" under an icon is worse than the generic string.
const ipPage = await (await kukuroo.handle(
  new Request("http://192.168.1.9:8787/push/enroll"), env)).text();
ok("a bare IP falls back rather than naming the app after an octet",
  ipPage.includes("<title>Enroll this device</title>"));

// The page ships its JavaScript inline, and the HTML tokenizer ends a script
// element at the first closing tag it sees, without parsing the JS around it. A
// closing tag anywhere in that source, in a string or even in a comment, cuts the
// script short and renders the remainder as visible text. That is not cosmetic:
// everything past the cut never runs, so the form loses its submit handler and the
// iOS gate never appears, which reads as three unrelated bugs.
//
// Three checks, because they fail on different things and none subsumes the rest.
// One closing tag is what catches the truncation. The submit handler surviving the
// cut is what proves the script the browser gets is the whole script: truncation
// can land inside a comment and leave behind something that parses perfectly well,
// as the original bug did. And the parse is what catches an ordinary syntax error,
// which nothing else here would, because this source is a string as far as the
// compiler is concerned and tsc never looks inside it.
const scratch = mkdtempSync(join(tmpdir(), "kukuroo-page-"));
for (const [label, page] of [["gated", gatedPage], ["open", openPage]]) {
  const closes = page.split("</scr" + "ipt").length - 1;
  ok(`the ${label} page closes its script exactly once`, closes === 1);

  const body = page.slice(
    page.indexOf(">", page.indexOf("<script")) + 1,
    page.indexOf("</scr" + "ipt"),
  );
  ok(`the ${label} page delivers its whole script to the browser`,
    body.includes('addEventListener("submit"'));

  const file = join(scratch, `${label}.mjs`);
  writeFileSync(file, body);
  let parsed = true;
  let complaint = "";
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    parsed = false;
    complaint = String(error.stderr ?? "").split("\n").slice(0, 3).join(" ");
  }
  ok(`the ${label} page's client JavaScript parses${parsed ? "" : `: ${complaint}`}`, parsed);
}

// ---- the page's repair of a subscription made under an older VAPID key ------
//
// subscribe() does not replace a subscription created under a different key, it
// throws InvalidStateError. So a device whose deployment has been re-keyed can
// never enroll again from this page, however many times it taps the button, and
// the only fix left is deleting the installed app. The page reads the held key
// and drops the subscription first.
//
// Lifted out of the page source and run here because the alternative is trusting
// a substring, and a substring cannot tell "unsubscribes a stale subscription"
// from "unsubscribes whatever it finds", which would silently re-enroll working
// devices under new endpoints. The slice is the two functions, which sit between
// b64urlToBytes and the submit handler.
{
  const source = gatedPage.slice(
    gatedPage.indexOf(">", gatedPage.indexOf("<script")) + 1,
    gatedPage.indexOf("</scr" + "ipt"),
  );
  const region = source.slice(
    source.indexOf("function sameKey"),
    source.indexOf('form.addEventListener("submit"'),
  );
  // `window` is a parameter rather than a global, so each case gets its own
  // browser and nothing here has to be undone afterwards.
  const helpersFor = (window) => new Function(
    "window",
    region + "\nreturn { sameKey, clearMismatchedSubscription };",
  )(window);
  const { sameKey } = helpersFor(undefined);

  const key = Uint8Array.from([1, 2, 3, 4]);
  ok("sameKey matches identical bytes", sameKey(Uint8Array.from(key).buffer, key));
  ok("sameKey rejects different bytes", !sameKey(Uint8Array.from([1, 2, 3, 5]).buffer, key));
  ok("sameKey rejects a different length", !sameKey(Uint8Array.from([1, 2, 3]).buffer, key));
  ok("sameKey rejects a key it was not given", !sameKey(null, key));

  // `options` is what the browser reports the subscription was created with;
  // undefined stands for the browsers that do not expose it at all.
  const held = (options) => {
    const subscription = { options, unsubscribed: false };
    subscription.unsubscribe = async () => { subscription.unsubscribed = true; };
    return subscription;
  };
  const clearWith = (subscription) => helpersFor({
    pushManager: {
      async getSubscription() {
        if (subscription === "throws") throw new Error("no getSubscription here");
        return subscription;
      },
    },
  }).clearMismatchedSubscription(key);

  ok("nothing held means nothing to repair", (await clearWith(null)) === null);
  ok("a browser that cannot be asked is left alone", (await clearWith("throws")) === null);

  const current = held({ applicationServerKey: Uint8Array.from(key).buffer });
  ok("a subscription under the current key survives",
    (await clearWith(current)) === current && !current.unsubscribed);

  const stale = held({ applicationServerKey: Uint8Array.from([9, 9, 9, 9]).buffer });
  ok("a subscription under an older key is dropped",
    (await clearWith(stale)) === null && stale.unsubscribed);

  // Not dropped on suspicion: re-subscribing mints a new endpoint, so guessing
  // here would re-enroll healthy devices and orphan their rows. It is handed
  // back instead, for the submit handler to unsubscribe if subscribe() throws.
  const opaque = held(undefined);
  ok("a subscription whose key cannot be read is handed back, not dropped",
    (await clearWith(opaque)) === opaque && !opaque.unsubscribed);
}

// ---- the navigate origin, when nobody configured one -----------------------
//
// This is what removed the second deploy from `kukuroo init`. A workers.dev
// address is only knowable after a deploy, so setup used to deploy, read the
// address, write it into the config as KUKUROO_NAVIGATE_ORIGIN, and deploy
// again. A Worker serving its own enrollment page can read the same answer off
// the request it is already answering.
{
  const sendTo = (routes, url, navigate, over = {}) =>
    routes.handle(
      new Request(url + "/push/send", {
        method: "POST",
        headers: { authorization: "Bearer token-token-token" },
        body: JSON.stringify({ notification: { title: "hi", navigate } }),
      }),
      { ...env, ...over },
    );

  const serving = mountKukuroo({ prefix: "/push", standalone: true });
  const apiOnly = mountKukuroo({ prefix: "/push", standalone: false });

  const offOrigin = await sendTo(serving, "https://demo.acct.workers.dev", "https://elsewhere.example/x");
  ok("a page-serving Worker enforces its own origin with nothing configured",
    offOrigin.status === 400 &&
      (await offOrigin.json()).error.includes("demo.acct.workers.dev"));
  ok("and still accepts a navigate that is on it",
    (await sendTo(serving, "https://demo.acct.workers.dev", "https://demo.acct.workers.dev/")).status === 200);

  // Configured always wins, or moving to a hostname of your own could never be
  // enforced from the old one while the move is in progress.
  const pinned = await sendTo(serving, "https://demo.acct.workers.dev", "https://demo.acct.workers.dev/",
    { KUKUROO_NAVIGATE_ORIGIN: "https://push.example.com" });
  ok("an explicit navigate origin overrides the request's own",
    pinned.status === 400 && (await pinned.json()).error.includes("push.example.com"));

  // The page is on somebody else's origin here, so this Worker's own origin is
  // the wrong answer and guessing it would reject every correct navigate.
  ok("a Worker with no page of its own infers nothing",
    (await sendTo(apiOnly, "https://api.example.com", "https://www.example.com/read")).status === 200);
}

// The default is the safe one: an option that is absent, misspelled, or lost in
// a config that never reached the Worker leaves the gate standing.
const defaulted = mountKukuroo({ prefix: "/push", standalone: true });
ok("requireInvite defaults to on",
  (await defaulted.handle(req("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: subscriptionBody() }),
  }), openEnv)).status === 403);

// ---------------------------------------------------------------------------
// The key derivation, as a public contract.
//
// A host that wants to know whether one endpoint is enrolled has two ways to
// ask. Listing the namespace and comparing `.endpoint` on every row is the one
// available without these exports, and it answers wrongly for the case that
// matters most: KV's list is eventually consistent, so a device that enrolled a
// second ago reads as not enrolled. A point read at this key does not have that
// failure.
//
// Which is only true while this function names the key `putSubscription`
// actually writes. Imported from the package root rather than from
// subscriptions.ts, because "a host can reach it" is half of what is being
// promised, and asserted against the stored key rather than a literal, so the
// two move together or this fails.
// ---------------------------------------------------------------------------
{
  const { subscriptionKey, KEY_PREFIX } = await import("../src/index.ts");

  const kv = fakeKV();
  const body = subscriptionBody();
  const stored = await mountKukuroo({ prefix: "/push", requireInvite: false }).handle(
    req("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: body }) }),
    { ...env, KUKUROO_SUBS: kv },
  );
  ok("the package root exports the key derivation",
    typeof subscriptionKey === "function" && KEY_PREFIX === "sub:");

  const [written] = [...kv.store.keys()];
  ok("subscribe stored exactly one row", stored.status === 200 && kv.store.size === 1);
  ok("subscriptionKey names the row subscribe just wrote",
    (await subscriptionKey(body.endpoint)) === written);
  ok("and the row it names is reachable by a point read",
    JSON.parse(await kv.get(await subscriptionKey(body.endpoint))).endpoint === body.endpoint);
  ok("the derived key carries the prefix listing filters on",
    (await subscriptionKey(body.endpoint)).startsWith(KEY_PREFIX));

  // A different device is a different row, or the point read above would be a
  // lookup that confidently returns somebody else's subscription.
  ok("a different endpoint derives a different key",
    (await subscriptionKey(body.endpoint + "x")) !== written);
}

console.error = realConsoleError;
