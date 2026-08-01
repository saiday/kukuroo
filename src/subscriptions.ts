/**
 * Subscription storage.
 *
 * This is the one piece of state in a Kukuroo deployment that cannot be a file,
 * because the device writes it rather than the operator. It is written by
 * `/push/subscribe`, read only by the sender, and never read to render a page.
 */

import { b64urlEncode } from "./bytes.ts";
import type { PushSubscriptionKeys } from "./encrypt.ts";

export const KEY_PREFIX = "sub:";

export interface StoredSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** ISO 8601, for working out how old an enrolment is when one goes wrong. */
  createdAt: string;
  /** Free-form, supplied at enrolment. "iPhone", usually. */
  label?: string;
}

/**
 * Key derived from the endpoint, so re-enrolling the same device overwrites its
 * row instead of adding a second one and doubling every notification.
 */
export async function subscriptionKey(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return KEY_PREFIX + b64urlEncode(new Uint8Array(digest)).slice(0, 22);
}

export async function putSubscription(
  kv: KVNamespace,
  subscription: StoredSubscription,
): Promise<string> {
  const key = await subscriptionKey(subscription.endpoint);
  await kv.put(key, JSON.stringify(subscription));
  return key;
}

export async function listSubscriptions(
  kv: KVNamespace,
): Promise<Array<{ key: string; subscription: StoredSubscription }>> {
  const out: Array<{ key: string; subscription: StoredSubscription }> = [];
  let cursor: string | undefined;

  do {
    const page = await kv.list({ prefix: KEY_PREFIX, cursor });
    for (const entry of page.keys) {
      const raw = await kv.get(entry.name);
      if (raw === null) continue; // deleted between list and get
      out.push({ key: entry.name, subscription: JSON.parse(raw) as StoredSubscription });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  return out;
}

export async function deleteSubscription(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

/**
 * Validate what the enrolment page posted. A malformed subscription stored now
 * is a send that fails much later, at which point nothing points back here.
 */
export function parseSubscriptionBody(body: unknown): StoredSubscription {
  const b = body as Record<string, unknown> | null;
  const endpoint = b?.endpoint;
  const keys = b?.keys as Record<string, unknown> | undefined;

  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) {
    throw new Error("endpoint must be an https URL");
  }
  if (typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") {
    throw new Error("keys.p256dh and keys.auth are required");
  }

  const label = typeof b?.label === "string" ? b.label.slice(0, 64) : undefined;

  return {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    createdAt: new Date().toISOString(),
    ...(label !== undefined ? { label } : {}),
  };
}
