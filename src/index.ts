/**
 * Kukuroo. Send Web Push notifications to your own devices from anything.
 *
 * Two ways in:
 *
 *   mountKukuroo({ prefix: "/push" })   route set for a host Worker
 *   send(env, { notification })         one call, fans out over every device
 *
 * Two things are permanent once a device has enrolled: the VAPID keypair and
 * the origin devices enroll on. Changing either strands every subscription
 * silently, and silence is what this module exists to make impossible.
 */

export { importVapidKeys, type VapidKeys } from "./vapid.ts";
export { mountKukuroo, type KukurooRoutes, type MountOptions } from "./mount.ts";
export { send, type SendOptions, type SendResult } from "./send.ts";
export { type PayloadPolicy } from "./payload.ts";
export {
  buildDeclarativePayload,
  PAYLOAD_BUDGET_BYTES,
  type BuildPayloadOptions,
  type DeclarativeNotification,
} from "./payload.ts";
export { enrollmentPage, type EnrollmentPageOptions } from "./enroll-page.ts";
export { InvalidRequest } from "./errors.ts";
export type { KukurooEnv } from "./env.ts";
// `subscriptionKey` and `KEY_PREFIX` are exported so a host can find the row for
// one endpoint with a point read, rather than listing the namespace and
// comparing `.endpoint` on every row it holds. Listing cannot answer the
// question a host actually has: KV's list is eventually consistent, so a device
// that enrolled a second ago is reported as not enrolled, and a page that acts
// on that tells somebody their enrollment failed while the row sits in KV.
//
// Exporting the derivation makes it a contract. It is the key layout devices are
// already stored under, so it was never free to change -- an altered hash
// orphans every existing row -- and saying so here costs nothing that was not
// already owed. The alternative is what hosts do without it, which is copy these
// six lines and silently diverge.
export { KEY_PREFIX, subscriptionKey, type StoredSubscription } from "./subscriptions.ts";
export type { PushSubscriptionKeys } from "./encrypt.ts";
