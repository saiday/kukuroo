/**
 * The bindings a Kukuroo deployment needs.
 *
 * Host Workers extend their own `Env` with this, so a missing binding is a type
 * error at build time rather than a 500 the first time someone enrols.
 */
export interface KukurooEnv {
  /** KV namespace holding the subscriptions. */
  KUKUROO_SUBS: KVNamespace;

  /**
   * Worker Secret. The ES256 private half of the VAPID keypair, as base64url of
   * the 32-byte scalar, a JWK, or PKCS#8. Generate once, never rotate, keep an
   * offline copy.
   */
  KUKUROO_VAPID_PRIVATE: string;

  /**
   * Plain var, not a secret: the enrolment page needs it client-side to call
   * `pushManager.subscribe()`. base64url of the uncompressed P-256 point.
   */
  KUKUROO_VAPID_PUBLIC: string;

  /** Worker Secret. Bearer token for `POST /push/send`. */
  KUKUROO_SEND_TOKEN: string;

  /** Worker Secret. Gate on `POST /push/subscribe`. */
  KUKUROO_INVITE_CODE: string;

  /**
   * Optional. The VAPID `sub` claim: a mailto: or https: URI identifying the
   * sender. Defaults to the push service's own origin, which Apple accepts.
   */
  KUKUROO_VAPID_SUBJECT?: string;
}
