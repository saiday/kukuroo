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
export type { StoredSubscription } from "./subscriptions.ts";
export type { PushSubscriptionKeys } from "./encrypt.ts";
