/**
 * The route set. Three endpoints, two of them gated.
 *
 *   POST <prefix>/subscribe   invite-gated    stores a subscription in KV
 *   POST <prefix>/send        bearer-gated    encrypts and fans out
 *   GET  <prefix>/enroll      open            the bundled enrolment page
 *
 * `handle` returns `null` for anything it does not own, so a host Worker can
 * fall through to its own routing without Kukuroo having to know about it.
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
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
function requireSecret(value: string | undefined, name: string): string | Response {
  if (typeof value === "string" && value.length > 0) return value;
  console.error(`kukuroo: ${name} is not set on this Worker.`);
  return json(
    { error: `${name} is not configured on this Worker. Run \`npx kukuroo init\`.` },
    503,
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

export function mountKukuroo(options: MountOptions = {}): KukurooRoutes {
  const prefix = (options.prefix ?? "/push").replace(/\/+$/, "");

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
      if (route === "/public-key" && request.method === "GET") {
        try {
          const { publicKeyB64 } = await importVapidKeys(
            env.KUKUROO_VAPID_PRIVATE,
            env.KUKUROO_VAPID_PUBLIC,
          );
          return json({ publicKey: publicKeyB64 });
        } catch (error) {
          console.error("kukuroo: VAPID key is not usable:", error);
          return json({ error: "the VAPID key on this Worker is not usable" }, 503);
        }
      }

      if (route === "/subscribe") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        return handleSubscribe(request, env);
      }

      if (route === "/send") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        return handleSend(request, env);
      }

      return json({ error: "not found" }, 404);
    },
  };
}

async function handleSubscribe(request: Request, env: KukurooEnv): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const expected = requireSecret(env.KUKUROO_INVITE_CODE, "KUKUROO_INVITE_CODE");
  if (expected instanceof Response) return expected;

  const invite = typeof body.invite === "string" ? body.invite : "";
  if (!secretEquals(invite, expected)) {
    return json({ error: "invalid invite code" }, 403);
  }

  let subscription;
  try {
    subscription = parseSubscriptionBody(body.subscription ?? body, body.label);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  await putSubscription(env.KUKUROO_SUBS, subscription);
  return json({ ok: true });
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
