/**
 * The Declarative Web Push payload, and the validation that keeps it from
 * failing silently.
 *
 * WebKit discriminates on the `web_push: 8030` key inside the decrypted JSON.
 * If the payload parses, the browser renders the notification itself with no
 * service worker involved. If it does *not* parse, WebKit discards the whole
 * thing and falls through to the service worker push handler, which in a
 * declarative-only deployment does not exist. Nothing is displayed, nothing is
 * logged, and the send returned 201.
 *
 * So every check in this file exists because its absence is invisible.
 */

import { InvalidRequest } from "./errors.ts";

/** The complete set of members WebKit's parser reads inside `notification`. */
export interface DeclarativeNotification {
  /** Required. */
  title: string;
  /** Required, and must be absolute. See the validator. */
  navigate: string;
  body?: string;
  /** Notifications sharing a tag replace each other rather than stacking. */
  tag?: string;
  /** Must be a valid absolute URL if present, or the whole parse is discarded. */
  icon?: string;
  dir?: "auto" | "ltr" | "rtl";
  lang?: string;
  silent?: boolean;
  data?: unknown;
}

export interface BuildPayloadOptions {
  notification: DeclarativeNotification;
  /** Number on the Home Screen icon. Emitted in both positions; see below. */
  appBadge?: number;
  /** Only set this if a service worker needs a chance to replace the notification. */
  mutable?: boolean;
}

/**
 * Fields that are in the W3C Notifications spec, are not implemented by WebKit,
 * and are silently ignored rather than rejected. Callers reaching for these are
 * usually about to be confused, so we say so at build time instead.
 */
const IGNORED_BY_WEBKIT = [
  "image",
  "badge",
  "vibrate",
  "timestamp",
  "renotify",
  "requireInteraction",
  "actions",
] as const;

/**
 * The wire limit is 4,096 bytes for the encrypted body. RFC 8188 framing plus
 * the GCM tag account for the difference, so the JSON budget is about 3,900.
 * Going over does not error anywhere: the message is simply never delivered.
 */
export const PAYLOAD_BUDGET_BYTES = 3900;

function assertAbsoluteUrl(value: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidRequest(
      `notification.${field} must be an absolute URL. WebKit constructs it with a ` +
        `single-argument URL() and no base, so a relative path fails validation and ` +
        `discards the entire declarative payload. Got: ${JSON.stringify(value)}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidRequest(`notification.${field} must be http(s); got ${parsed.protocol}`);
  }
}

/**
 * The type checks the cast at the entry point cannot make.
 *
 * `options` arrives from `await request.json()` as whatever the sender wrote,
 * and the `as SendOptions` at the route is a compile-time claim about runtime
 * data. WebKit discards the whole declarative payload when any member has the
 * wrong type, so a numeric `body` is not a smaller mistake than a missing
 * title: both display nothing and both return 201.
 */
function assertType(
  value: unknown,
  expected: "string" | "boolean",
  field: string,
): void {
  if (value === undefined || typeof value === expected) return;
  throw new InvalidRequest(
    `${field} must be a ${expected}; got ${Array.isArray(value) ? "array" : typeof value}. ` +
      `WebKit discards the entire declarative payload on a type mismatch, so the ` +
      `notification would be accepted by the push service and displayed by nobody.`,
  );
}

/**
 * Build and validate the payload, and absorb the `app_badge` position quirk.
 *
 * `app_badge` moved between Safari versions and Apple never documented the
 * move: inside `notification` on 18.4 through 18.6, top level on 26.0+, top
 * level with a fallback on 26.1+. Unknown members are ignored rather than
 * rejected, so emitting it in *both* positions is correct on every version, and
 * doing it here means no caller has to know which iOS a given device is on.
 */
export interface PayloadPolicy {
  /**
   * If set, `navigate` must be on this origin.
   *
   * Mounting Kukuroo into the app's own Worker is what makes every notification
   * land back inside the installed web app, and it is the reason the unverified
   * cross-origin question does not apply. But mounting only makes same-origin
   * *likely*; this makes it true. Without it the guarantee rests on every future
   * caller remembering, and a `navigate` that leaves the origin ejects the user
   * from the installed app into a browser tab.
   *
   * Deliberately not applied to `icon`, which legitimately points at a CDN.
   */
  navigateOrigin?: string;
}

export function buildDeclarativePayload(
  options: BuildPayloadOptions,
  policy: PayloadPolicy = {},
): string {
  const { notification, appBadge, mutable } = options;

  if (typeof notification?.title !== "string" || notification.title.length === 0) {
    throw new InvalidRequest("notification.title is required; the message is rejected without it");
  }
  if (typeof notification.navigate !== "string" || notification.navigate.length === 0) {
    throw new InvalidRequest(
      "notification.navigate is required; the message is rejected without it",
    );
  }

  assertType(notification.body, "string", "notification.body");
  assertType(notification.tag, "string", "notification.tag");
  assertType(notification.icon, "string", "notification.icon");
  assertType(notification.lang, "string", "notification.lang");
  assertType(notification.silent, "boolean", "notification.silent");
  assertType(mutable, "boolean", "mutable");

  assertAbsoluteUrl(notification.navigate, "navigate");
  if (notification.icon !== undefined) {
    assertAbsoluteUrl(notification.icon, "icon");
  }

  if (policy.navigateOrigin !== undefined) {
    // Normalised the same way KUKUROO_ALLOWED_ORIGINS is, and for the same
    // reason: this is an operator-supplied string, and a trailing slash is
    // exactly what a browser address bar hands you. Comparing it raw makes that
    // one keystroke reject every notification the deployment will ever send.
    // A malformed value is the operator's fault rather than the caller's, so it
    // is not an InvalidRequest and must not be reported to the sender as one.
    let allowed: string;
    try {
      allowed = new URL(policy.navigateOrigin).origin;
    } catch {
      throw new Error(
        `KUKUROO_NAVIGATE_ORIGIN is ${JSON.stringify(policy.navigateOrigin)}, which is not ` +
          `an origin (expected e.g. "https://push.example.com"). Every send is rejected ` +
          `until it is fixed or removed.`,
      );
    }
    const target = new URL(notification.navigate).origin;
    if (target !== allowed) {
      throw new InvalidRequest(
        `notification.navigate points at ${target}, but this deployment restricts it to ` +
          `${allowed}. Tapping a notification that leaves the origin ejects ` +
          `the user out of the installed web app into a browser tab.`,
      );
    }
  }
  if (notification.dir !== undefined && !["auto", "ltr", "rtl"].includes(notification.dir)) {
    throw new InvalidRequest(`notification.dir must be auto, ltr, or rtl; got ${notification.dir}`);
  }

  const strays = IGNORED_BY_WEBKIT.filter((f) => f in notification);
  if (strays.length > 0) {
    throw new InvalidRequest(
      `notification carries ${strays.join(", ")}, which WebKit does not implement and ` +
        `silently ignores. Remove them so the payload says what it does.`,
    );
  }

  const inner: Record<string, unknown> = {
    title: notification.title,
    navigate: notification.navigate,
  };
  if (notification.body !== undefined) inner.body = notification.body;
  if (notification.tag !== undefined) inner.tag = notification.tag;
  if (notification.icon !== undefined) inner.icon = notification.icon;
  if (notification.dir !== undefined) inner.dir = notification.dir;
  if (notification.lang !== undefined) inner.lang = notification.lang;
  if (notification.silent !== undefined) inner.silent = notification.silent;
  if (notification.data !== undefined) inner.data = notification.data;

  const payload: Record<string, unknown> = { web_push: 8030, notification: inner };

  if (appBadge !== undefined) {
    if (!Number.isInteger(appBadge) || appBadge < 0) {
      throw new InvalidRequest(`app_badge must be a non-negative integer; got ${appBadge}`);
    }
    payload.app_badge = appBadge; // 26.0+
    inner.app_badge = appBadge; // 18.4-18.6
  }
  if (mutable !== undefined) payload.mutable = mutable;

  const json = JSON.stringify(payload);
  const size = new TextEncoder().encode(json).length;
  if (size > PAYLOAD_BUDGET_BYTES) {
    throw new InvalidRequest(
      `payload is ${size} bytes, over the ~${PAYLOAD_BUDGET_BYTES}-byte budget. ` +
        `An oversize message is not rejected by the push service; it is accepted and ` +
        `never delivered. Failing here instead.`,
    );
  }

  return json;
}
