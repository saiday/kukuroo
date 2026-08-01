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
    throw new Error(
      `notification.${field} must be an absolute URL. WebKit constructs it with a ` +
        `single-argument URL() and no base, so a relative path fails validation and ` +
        `discards the entire declarative payload. Got: ${JSON.stringify(value)}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`notification.${field} must be http(s); got ${parsed.protocol}`);
  }
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
export function buildDeclarativePayload(options: BuildPayloadOptions): string {
  const { notification, appBadge, mutable } = options;

  if (typeof notification?.title !== "string" || notification.title.length === 0) {
    throw new Error("notification.title is required; the message is rejected without it");
  }
  if (typeof notification.navigate !== "string" || notification.navigate.length === 0) {
    throw new Error("notification.navigate is required; the message is rejected without it");
  }

  assertAbsoluteUrl(notification.navigate, "navigate");
  if (notification.icon !== undefined) {
    assertAbsoluteUrl(notification.icon, "icon");
  }
  if (notification.dir !== undefined && !["auto", "ltr", "rtl"].includes(notification.dir)) {
    throw new Error(`notification.dir must be auto, ltr, or rtl; got ${notification.dir}`);
  }

  const strays = IGNORED_BY_WEBKIT.filter((f) => f in notification);
  if (strays.length > 0) {
    throw new Error(
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
      throw new Error(`app_badge must be a non-negative integer; got ${appBadge}`);
    }
    payload.app_badge = appBadge; // 26.0+
    inner.app_badge = appBadge; // 18.4-18.6
  }
  if (mutable !== undefined) payload.mutable = mutable;

  const json = JSON.stringify(payload);
  const size = new TextEncoder().encode(json).length;
  if (size > PAYLOAD_BUDGET_BYTES) {
    throw new Error(
      `payload is ${size} bytes, over the ~${PAYLOAD_BUDGET_BYTES}-byte budget. ` +
        `An oversize message is not rejected by the push service; it is accepted and ` +
        `never delivered. Failing here instead.`,
    );
  }

  return json;
}
