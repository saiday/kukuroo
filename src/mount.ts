/**
 * The route set. Four endpoints, two of them gated.
 *
 *   POST <prefix>/subscribe   invite-gated    stores a subscription in KV
 *   POST <prefix>/send        bearer-gated    encrypts and fans out
 *   GET  <prefix>/public-key  open            the VAPID public key
 *   GET  <prefix>/enroll      open            the bundled enrollment page
 *
 * `requireInvite: false` opens the first of those. See the option.
 *
 * `handle` returns `null` for anything it does not own, so a host Worker can
 * fall through to its own routing without Kukuroo having to know about it.
 *
 * With KUKUROO_ALLOWED_ORIGINS set, `subscribe` and `public-key` also answer
 * CORS preflights from the listed origins. `send` never does; see corsFor.
 */

import { enrollmentPage } from "./enroll-page.ts";
import type { KukurooEnv } from "./env.ts";
import { InvalidRequest } from "./errors.ts";
import { send, type SendOptions } from "./send.ts";
import { parseSubscriptionBody, putSubscription } from "./subscriptions.ts";
import { importVapidKeys } from "./vapid.ts";

export interface MountOptions {
  /** Where the route set lives. No trailing slash. */
  prefix?: string;
  /**
   * Serve the bundled enrollment page at `<prefix>/enroll`. Mounted deployments
   * supply their own UI on their own origin and should leave this off.
   */
  standalone?: boolean;
  /**
   * Whether `<prefix>/subscribe` demands the invite code. Default true.
   *
   * `false` is a deliberate answer to one question: is this deployment personal?
   * A push endpoint for one person's own phones is worth gating, because the
   * gate is what stops a stranger who finds the URL from enrolling their own
   * device and reading the titles of everything you send. A channel meant for
   * whoever turns up is not, and there the code is friction that buys nothing.
   *
   * Off, the enrollment page drops its code field and the endpoint accepts any
   * well-formed subscription. Nothing else changes: KUKUROO_INVITE_CODE stays
   * generated and stored, so turning the gate back on is this one word plus a
   * deploy, with no device re-enrolling.
   */
  requireInvite?: boolean;
}

export interface KukurooRoutes {
  prefix: string;
  /** Returns a Response for a Kukuroo route, or null if the path is not ours. */
  handle(request: Request, env: KukurooEnv): Promise<Response | null>;
}

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

/**
 * Comparison that does not leak the answer through timing. Both gates here
 * guard something worth guarding: the send token lets anyone spam the device,
 * and the invite code lets anyone enroll their own phone and start reading the
 * owner's notification titles.
 */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A binding that was never configured arrives as `undefined`, and comparing
 * against it throws rather than returning false. That surfaces as an opaque 500
 * on every enrollment attempt, which reads as "the service is broken" instead of
 * "you skipped a setup step". Given how many manual steps stand between a fresh
 * account and a working deployment, this is likely rather than hypothetical.
 */
function requireSecret(
  value: string | undefined,
  name: string,
  extraHeaders: Record<string, string> = {},
): string | Response {
  if (typeof value === "string" && value.length > 0) return value;
  console.error(`kukuroo: ${name} is not set on this Worker.`);
  return json(
    { error: `${name} is not configured on this Worker. Run \`npx kukuroo init\`.` },
    503,
    extraHeaders,
  );
}

/**
 * The same courtesy as requireSecret, for the one binding that is not a string.
 *
 * `env.KUKUROO_SUBS` is a KV namespace, so an unconfigured one is `undefined`
 * and the first `.put` on it throws a TypeError straight out of `handle()`.
 * The operator sees Cloudflare's opaque 1101 page on every enrollment while the
 * cause is one missing line of wrangler config, and the binding name is not
 * configurable, so it is the easiest step in the whole setup to skip.
 */
function requireSubs(
  env: KukurooEnv,
  extraHeaders: Record<string, string> = {},
): KVNamespace | Response {
  if (env.KUKUROO_SUBS !== undefined && env.KUKUROO_SUBS !== null) return env.KUKUROO_SUBS;
  console.error("kukuroo: the KUKUROO_SUBS KV namespace is not bound to this Worker.");
  return json(
    {
      error:
        "KUKUROO_SUBS is not bound on this Worker. Add it to your wrangler config: " +
        '"kv_namespaces": [{ "binding": "KUKUROO_SUBS", "id": "..." }].',
    },
    503,
    extraHeaders,
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * CORS is operator policy from the environment, like the navigate origin.
 * Unset, no CORS header is ever emitted and cross-origin browser calls fail,
 * which is the right default for a deployment that serves its own enrollment.
 *
 * Only `subscribe` and `public-key` ever get CORS headers. `send` never does,
 * deliberately: the send token is a server secret, and a browser page holding
 * one is a leak in progress. Refusing CORS there makes that mistake fail on
 * its first test rather than work quietly until someone views source.
 *
 * Entries are normalised through `new URL().origin`, so a stray path or a
 * default port does not silently fail to match. There is no wildcard: the
 * list of pages that may enroll a device is short, and writing it out is the
 * point.
 *
 * The parse cache lives per mount, not per module, so two route sets with
 * different lists cannot thrash each other, and "the junk entry is reported
 * once" is a promise the code keeps rather than a comment that hopes.
 */
interface OriginsCache {
  raw?: string;
  origins: string[];
}

function parseAllowedOrigins(env: KukurooEnv, cache: OriginsCache): string[] {
  const raw = env.KUKUROO_ALLOWED_ORIGINS ?? "";
  if (cache.raw === raw) return cache.origins;

  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    try {
      const origin = new URL(trimmed).origin;
      if (origin === "null") throw new Error("an opaque origin matches nothing");
      origins.push(origin);
    } catch {
      console.error(
        `kukuroo: KUKUROO_ALLOWED_ORIGINS entry ${JSON.stringify(trimmed)} is not an ` +
          `origin (expected e.g. "https://www.example.com"); ignoring it.`,
      );
    }
  }
  cache.raw = raw;
  cache.origins = origins;
  return origins;
}

function corsFor(request: Request, env: KukurooEnv, cache: OriginsCache): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin === null || !parseAllowedOrigins(env, cache).includes(origin)) return {};
  // Echo the one origin rather than `*`, and Vary so shared caches key on it.
  return { "access-control-allow-origin": origin, vary: "origin" };
}

/**
 * Answer a preflight, or say plainly why not. A disallowed origin gets a 403
 * naming the variable, and a preflight against a deployment with CORS off
 * gets told that CORS is off, because the alternative the developer sees is
 * an opaque shrug in the browser console and nothing anywhere else.
 */
function preflight(
  request: Request,
  env: KukurooEnv,
  cache: OriginsCache,
  allowMethods: string,
): Response {
  const cors = corsFor(request, env, cache);
  if ("access-control-allow-origin" in cors) {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": allowMethods,
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  const origin = request.headers.get("origin");
  if (origin !== null && parseAllowedOrigins(env, cache).length > 0) {
    return json({ error: `origin ${origin} is not in KUKUROO_ALLOWED_ORIGINS` }, 403);
  }
  if (request.headers.get("access-control-request-method") !== null) {
    // A genuine preflight, and CORS is not configured. "Method not allowed"
    // would read as a routing bug; name the actual gap instead.
    return json(
      {
        error:
          "cross-origin calls are not enabled: KUKUROO_ALLOWED_ORIGINS is not set on this Worker",
      },
      403,
    );
  }
  return json({ error: "method not allowed" }, 405);
}

/**
 * Normalise the prefix into the one shape the path test can reason about: a
 * leading slash, no trailing one, and "" meaning the root.
 *
 * Both ends of this were wrong in opposite directions. `"push"` without the
 * leading slash could never match `url.pathname`, so every route silently
 * unmounted and the deploy still succeeded. `"/"` collapsed to `""`, after
 * which `startsWith("/")` matched every request in existence and Kukuroo
 * answered the host Worker's own pages with its 404.
 */
function normalizePrefix(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

/**
 * Settle the origin every notification's `navigate` must be on.
 *
 * KUKUROO_NAVIGATE_ORIGIN wins whenever it is set. Failing that, a deployment
 * serving its own enrollment page *is* the origin devices enrolled on, and it
 * learns that from the request it is answering rather than from configuration.
 *
 * Which is the only way a workers.dev deployment can enforce this on its first
 * deploy. The address is `<worker>.<account-subdomain>.workers.dev` and nothing
 * tells an account its own subdomain until a Worker is live on it, so setup
 * used to deploy, read the address off wrangler's output, write it into the
 * config, and deploy a second time purely to fill in this one string.
 *
 * A deployment that does *not* serve the page infers nothing. There the page is
 * on an origin of the operator's own and this one is just the API behind it, so
 * a guess would reject every correct `navigate` instead of the wrong ones.
 */
function withNavigateOrigin(request: Request, env: KukurooEnv, standalone: boolean): KukurooEnv {
  if (env.KUKUROO_NAVIGATE_ORIGIN || !standalone) return env;
  return { ...env, KUKUROO_NAVIGATE_ORIGIN: new URL(request.url).origin };
}

export function mountKukuroo(options: MountOptions = {}): KukurooRoutes {
  const prefix = normalizePrefix(options.prefix ?? "/push");
  const originsCache: OriginsCache = { origins: [] };
  // Default on, and only an explicit `false` turns it off. An absent option, a
  // typo'd one, or a var that failed to reach the Worker all leave the gate
  // standing, because the failure mode of the other default is an open
  // endpoint that reports nothing.
  const requireInvite = options.requireInvite !== false;

  return {
    prefix,

    async handle(request: Request, env: KukurooEnv): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return null;

      const route = url.pathname.slice(prefix.length) || "/";

      if (route === "/enroll" && request.method === "GET") {
        if (options.standalone !== true) return null;
        const page = enrollmentPage({
          subscribePath: prefix + "/subscribe",
          publicKeyPath: prefix + "/public-key",
          requireInvite,
        });
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // Public by nature: the client needs it to call `pushManager.subscribe()`.
      // Serving it means a deployment has one VAPID value to configure instead
      // of two, which removes the only way they can disagree.
      if (route === "/public-key") {
        if (request.method === "OPTIONS") return preflight(request, env, originsCache, "GET");
        const cors = corsFor(request, env, originsCache);
        if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);
        try {
          const { publicKeyB64 } = await importVapidKeys(
            env.KUKUROO_VAPID_PRIVATE,
            env.KUKUROO_VAPID_PUBLIC,
          );
          return json({ publicKey: publicKeyB64 }, 200, cors);
        } catch (error) {
          console.error("kukuroo: VAPID key is not usable:", error);
          return json({ error: "the VAPID key on this Worker is not usable" }, 503, cors);
        }
      }

      if (route === "/subscribe") {
        if (request.method === "OPTIONS") return preflight(request, env, originsCache, "POST");
        // CORS headers ride on every response from here down, including the
        // 4xx ones: without them the calling page cannot read the error it
        // needs to display.
        const cors = corsFor(request, env, originsCache);
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
        return handleSubscribe(request, env, cors, requireInvite);
      }

      if (route === "/send") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        return handleSend(request, withNavigateOrigin(request, env, options.standalone === true));
      }

      // Mounted at the root, Kukuroo owns no namespace of its own, so an
      // unrecognised path is the host Worker's business and must fall through.
      // Anywhere else the prefix is ours and a 404 is the honest answer.
      return prefix === "" ? null : json({ error: "not found" }, 404);
    },
  };
}

async function handleSubscribe(
  request: Request,
  env: KukurooEnv,
  cors: Record<string, string>,
  requireInvite: boolean,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "body must be JSON" }, 400, cors);
  }

  // `JSON.parse("null")` succeeds, and `typeof null === "object"`, so the catch
  // above never fires for a null body and every field read below it throws
  // instead. That escapes handle() as an unhandled exception and reaches the
  // enroller as Cloudflare's opaque 1101 page, which is precisely the answer
  // the 400 above exists to avoid.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "body must be a JSON object" }, 400, cors);
  }

  // With the gate open, the secret is not consulted at all: an `invite` in the
  // body is ignored rather than checked, so a deployment that turns the gate
  // off does not then fail on a stale code some page is still sending.
  if (requireInvite) {
    const expected = requireSecret(env.KUKUROO_INVITE_CODE, "KUKUROO_INVITE_CODE", cors);
    if (expected instanceof Response) return expected;

    const invite = typeof body.invite === "string" ? body.invite : "";
    if (!secretEquals(invite, expected)) {
      return json({ error: "invalid invite code" }, 403, cors);
    }
  }

  let subscription;
  try {
    subscription = parseSubscriptionBody(body.subscription ?? body, body.label);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400, cors);
  }

  const subs = requireSubs(env, cors);
  if (subs instanceof Response) return subs;

  await putSubscription(subs, subscription);
  return json({ ok: true }, 200, cors);
}

async function handleSend(request: Request, env: KukurooEnv): Promise<Response> {
  const expected = requireSecret(env.KUKUROO_SEND_TOKEN, "KUKUROO_SEND_TOKEN");
  if (expected instanceof Response) return expected;

  const token = bearerToken(request);
  if (token === null || !secretEquals(token, expected)) {
    return json({ error: "unauthorized" }, 401);
  }

  // Checked here rather than left to `send()`, so a missing key answers with
  // the 503 that names the variable, the same as GET <prefix>/public-key does
  // for the identical fault. Reached through send() it was a `.trim()` of
  // undefined, reported to the caller as a 400 about its own payload.
  const vapid = requireSecret(env.KUKUROO_VAPID_PRIVATE, "KUKUROO_VAPID_PRIVATE");
  if (vapid instanceof Response) return vapid;

  const subs = requireSubs(env);
  if (subs instanceof Response) return subs;

  let body: SendOptions;
  try {
    body = (await request.json()) as SendOptions;
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  try {
    const result = await send(env, body);
    // The fan-out count is the point of the response. A caller that sent to
    // zero subscriptions has not sent anything, and only this number says so.
    return json(result);
  } catch (error) {
    // 400 says "your body was wrong" and 503 says "this deployment is broken",
    // and the sender acts on the difference: a 400 is not worth retrying, so a
    // misconfigured Worker reported as one stops the retry and hides the
    // outage. Only the caller's own mistakes are thrown as InvalidRequest.
    if (error instanceof InvalidRequest) {
      return json({ error: error.message }, 400);
    }
    console.error("kukuroo: send failed:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 503);
  }
}
