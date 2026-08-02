/**
 * The sender. One call fans out over every stored subscription.
 *
 * Two things the caller is entitled to know and cannot work out for itself:
 * how many devices the message actually reached, and which subscriptions died.
 * A fan-out of zero is not a success, and this is the only place that can tell.
 */

import { encryptPayload } from "./encrypt.ts";
import { buildDeclarativePayload, type BuildPayloadOptions } from "./payload.ts";
import { utf8 } from "./bytes.ts";
import { deleteSubscription, listSubscriptions } from "./subscriptions.ts";
import { importVapidKeys, signVapidToken } from "./vapid.ts";
import type { KukurooEnv } from "./env.ts";

export interface SendOptions extends BuildPayloadOptions {
  /**
   * Web Push `Topic` header. An undelivered message is replaced by a later one
   * carrying the same topic, so a phone that has been off does not wake to a
   * queue of stale duplicates. Distinct from `notification.tag`, which collapses
   * notifications that have already been *displayed*.
   */
  topic?: string;
  /** Seconds the push service may hold an undelivered message. Default 4 hours. */
  ttl?: number;
}

export interface SendResult {
  /** Subscriptions the push service accepted the message for. */
  delivered: number;
  /** Subscriptions that returned 404 or 410 and have been deleted. */
  removed: number;
  /** Everything else: transient, retryable, or a bug. */
  failures: Array<{ endpoint: string; status: number | null; detail: string }>;
}

const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

/**
 * `sub` in the VAPID token must be a mailto: or https: URI. Apple rejects the
 * token without one and the 400 does not say why, so it is never left unset.
 *
 * The fallback is the *push service's* own origin, which is a valid https URI
 * and is accepted, but it identifies nobody. Set KUKUROO_VAPID_SUBJECT to a
 * mailto: you actually read if you want a push service to be able to reach you
 * about your traffic.
 */
function vapidSubject(env: KukurooEnv, endpoint: string): string {
  if (env.KUKUROO_VAPID_SUBJECT) return env.KUKUROO_VAPID_SUBJECT;
  return new URL(endpoint).origin;
}

export async function send(env: KukurooEnv, options: SendOptions): Promise<SendResult> {
  // Built and validated once, before any network call. If the payload is wrong
  // it is wrong for every device, and finding out after a partial fan-out is
  // strictly worse than finding out now.
  // The origin restriction is operator policy from the environment, never from
  // the request body: a caller holding the send token controls the body, so a
  // body-supplied limit would restrict nobody.
  const json = buildDeclarativePayload(options, {
    navigateOrigin: env.KUKUROO_NAVIGATE_ORIGIN,
  });
  const plaintext = utf8(json);

  const subscriptions = await listSubscriptions(env.KUKUROO_SUBS);
  const result: SendResult = { delivered: 0, removed: 0, failures: [] };

  if (subscriptions.length === 0) return result;

  const { privateKey, publicKeyB64 } = await importVapidKeys(
    env.KUKUROO_VAPID_PRIVATE,
    env.KUKUROO_VAPID_PUBLIC,
  );

  for (const { key, subscription } of subscriptions) {
    try {
      const endpoint = new URL(subscription.endpoint);
      const token = await signVapidToken(
        privateKey,
        endpoint.origin,
        vapidSubject(env, subscription.endpoint),
      );
      const body = await encryptPayload(plaintext, subscription.keys);

      const headers: Record<string, string> = {
        Authorization: `vapid t=${token}, k=${publicKeyB64}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(options.ttl ?? DEFAULT_TTL_SECONDS),
        Urgency: "normal",
      };
      if (options.topic !== undefined) headers.Topic = options.topic;

      const response = await fetch(subscription.endpoint, {
        method: "POST",
        headers,
        body: body as unknown as BodyInit,
      });

      if (response.status === 404 || response.status === 410) {
        // The subscription is gone: the icon was deleted, or the device rotated
        // it. Nothing tells the *owner* this happened, which is why a
        // deployment that cares about delivery needs a positive daily signal
        // rather than error detection.
        await deleteSubscription(env.KUKUROO_SUBS, key);
        result.removed += 1;
      } else if (response.ok) {
        result.delivered += 1;
      } else {
        result.failures.push({
          endpoint: subscription.endpoint,
          status: response.status,
          detail: (await response.text()).slice(0, 500),
        });
      }
    } catch (error) {
      result.failures.push({
        endpoint: subscription.endpoint,
        status: null,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
