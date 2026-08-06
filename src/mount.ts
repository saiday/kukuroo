/**
 * The route set. Four endpoints, two of them gated.
 *
 *   POST <prefix>/subscribe   invite-gated    stores a subscription in KV
 *   POST <prefix>/send        bearer-gated    encrypts and fans out
 *   GET  <prefix>/public-key  open            the VAPID public key
 *   GET  <prefix>/enroll      open            the bundled enrolment page
 *
 * `handle` returns `null` for anything it does not own, so a host Worker can
 * fall through to its own routing without Kukuroo having to know about it.
 *
 * With KUKUROO_ALLOWED_ORIGINS set, `subscribe` and `public-key` also answer
 * CORS preflights from the listed origins. `send` never does; see corsFor.
 */

import { enrolmentPage } from "./enroll-page.ts";
import type { KukurooEnv } from "./env.ts";
import { send, type SendOptions } from "./send.ts";
import { parseSubscriptionBody, putSubscription } from "./subscriptions.ts";
import { importVapidKeys } from "./vapid.ts";

export interface MountOptions {
  /** Where the route set lives. No trailing slash. */
  prefix?: string;
  /**
   * Serve the bundled enrolment page at `<prefix>/enroll`. Mounted deployments
   * supply their own UI on their own origin and should leave this off.
   */
  standalone?: boolean;
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
 * and the invite code lets anyone enrol their own phone and start reading the
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
 * on every enrolment attempt, which reads as "the service is broken" instead of
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

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * CORS is operator policy from the environment, like the navigate origin.
 * Unset, no CORS header is ever emitted and cross-origin browser calls fail,
 * which is the right default for a deployment that serves its own enrolment.
 *
 * Only `subscribe` and `public-key` ever get CORS headers. `send` never does,
 * deliberately: the send token is a server secret, and a browser page holding
 * one is a leak in progress. Refusing CORS there makes that mistake fail on
 * its first test rather than work quietly until someone views source.
 *
 * Entries are normalised through `new URL().origin`, so a stray path or a
 * default port does not silently fail to match. There is no wildcard: the
 * list of pages that may enrol a device is short, and writing it out is the
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

export function mountKukuroo(options: MountOptions = {}): KukurooRoutes {
  const prefix = (options.prefix ?? "/push").replace(/\/+$/, "");
  const originsCache: OriginsCache = { origins: [] };

  return {
    prefix,

    async handle(request: Request, env: KukurooEnv): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return null;

      const route = url.pathname.slice(prefix.length) || "/";

      if (route === "/enroll" && request.method === "GET") {
        if (options.standalone !== true) return null;
        const page = enrolmentPage({
          subscribePath: prefix + "/subscribe",
          publicKeyPath: prefix + "/public-key",
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
        if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
        const cors = corsFor(request, env, originsCache);
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
        return handleSubscribe(request, env, cors);
      }

      if (route === "/send") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        return handleSend(request, env);
      }

      return json({ error: "not found" }, 404);
    },
  };
}

async function handleSubscribe(
  request: Request,
  env: KukurooEnv,
  cors: Record<string, string>,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "body must be JSON" }, 400, cors);
  }

  const expected = requireSecret(env.KUKUROO_INVITE_CODE, "KUKUROO_INVITE_CODE", cors);
  if (expected instanceof Response) return expected;

  const invite = typeof body.invite === "string" ? body.invite : "";
  if (!secretEquals(invite, expected)) {
    return json({ error: "invalid invite code" }, 403, cors);
  }

  let subscription;
  try {
    subscription = parseSubscriptionBody(body.subscription ?? body, body.label);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400, cors);
  }

  await putSubscription(env.KUKUROO_SUBS, subscription);
  return json({ ok: true }, 200, cors);
}

async function handleSend(request: Request, env: KukurooEnv): Promise<Response> {
  const expected = requireSecret(env.KUKUROO_SEND_TOKEN, "KUKUROO_SEND_TOKEN");
  if (expected instanceof Response) return expected;

  const token = bearerToken(request);
  if (token === null || !secretEquals(token, expected)) {
    return json({ error: "unauthorized" }, 401);
  }

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
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}
