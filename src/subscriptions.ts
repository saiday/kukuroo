/**
 * Subscription storage.
 *
 * This is the one piece of state in a Kukuroo deployment that cannot be a file,
 * because the device writes it rather than the operator. It is written by
 * `/push/subscribe`, read only by the sender, and never read to render a page.
 */

import { b64urlDecode, b64urlEncode } from "./bytes.ts";
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
      // One unreadable row is one broken device, not a broken deployment. The
      // sender isolates every other per-subscription fault into
      // `SendResult.failures`; a parse error thrown from here would escape
      // that loop and stop the fan-out for everyone, on every send, until
      // someone found the row by hand.
      try {
        out.push({ key: entry.name, subscription: JSON.parse(raw) as StoredSubscription });
      } catch (error) {
        console.error(`kukuroo: skipping unreadable subscription ${entry.name}:`, error);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  return out;
}

export async function deleteSubscription(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

/**
 * Decode one key and check it is the size the crypto will demand of it, plus
 * the 0x04 tag that marks an uncompressed point. `b64urlDecode` accepts both
 * alphabets padded or not, so what fails here is genuinely malformed rather
 * than merely written in the other dialect.
 */
function assertKeyMaterial(value: string, field: string, expectedBytes: number): void {
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(value);
  } catch {
    throw new Error(`${field} is not valid base64url`);
  }
  if (bytes.length !== expectedBytes) {
    throw new Error(`${field} must decode to ${expectedBytes} bytes; got ${bytes.length}`);
  }
  if (expectedBytes === 65 && bytes[0] !== 0x04) {
    throw new Error(`${field} must be an uncompressed P-256 point (leading 0x04)`);
  }
}

/**
 * Validate what the enrolment page posted. A malformed subscription stored now
 * is a send that fails much later, at which point nothing points back here.
 */
export function parseSubscriptionBody(body: unknown, label?: unknown): StoredSubscription {
  const b = body as Record<string, unknown> | null;
  const endpoint = b?.endpoint;
  const keys = b?.keys as Record<string, unknown> | undefined;

  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) {
    throw new Error("endpoint must be an https URL");
  }
  if (typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") {
    throw new Error("keys.p256dh and keys.auth are required");
  }

  // Decoded and measured here rather than trusted as strings, because encrypt.ts
  // enforces these same two lengths and does it far too late: by then the row is
  // in KV, the phone has been told "enrolled", and the only symptom is a device
  // that counts as a failure on every send and never receives anything. This is
  // the last point at which the enroller is still listening.
  assertKeyMaterial(keys.p256dh, "keys.p256dh", 65);
  assertKeyMaterial(keys.auth, "keys.auth", 16);

  // The label rides alongside the subscription rather than inside it, because
  // what the browser hands back from `subscription.toJSON()` is not ours to add
  // fields to.
  const supplied = typeof label === "string" ? label : b?.label;
  const cleaned = typeof supplied === "string" ? supplied.slice(0, 64) : undefined;

  return {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    createdAt: new Date().toISOString(),
    ...(cleaned !== undefined ? { label: cleaned } : {}),
  };
}
