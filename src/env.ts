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
   * Worker Secret. The ES256 VAPID keypair, as a JWK, PKCS#8, or base64url of
   * the bare 32-byte scalar. Generate once, never rotate, keep an offline copy.
   *
   * Prefer a JWK. It carries the public half too, so KUKUROO_VAPID_PUBLIC
   * becomes unnecessary and the two values cannot drift apart.
   */
  KUKUROO_VAPID_PRIVATE: string;

  /**
   * Optional plain var, not a secret: base64url of the uncompressed P-256 point.
   *
   * Only required when the private key is stored as a bare 32-byte scalar,
   * which does not carry its public half. With a JWK or PKCS#8 the public key
   * is derived, and `GET <prefix>/public-key` serves it to the enrolment page,
   * so there is nothing to configure and nothing to mistype.
   *
   * When it *is* set it is verified against the private key rather than
   * trusted, because a mismatched pair delivers nothing and reports nothing.
   */
  KUKUROO_VAPID_PUBLIC?: string;

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
