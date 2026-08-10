/**
 * The bindings a Kukuroo deployment needs.
 *
 * Host Workers extend their own `Env` with this, so a missing binding is a type
 * error at build time rather than a 500 the first time someone enrolls.
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
   * is derived, and `GET <prefix>/public-key` serves it to the enrollment page,
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

  /**
   * Optional but recommended for mounted deployments: the origin every
   * notification's `navigate` must be on, e.g. `https://push.example.com`.
   *
   * Mounting makes same-origin likely; this makes it enforced. A `navigate`
   * that leaves the origin ejects the user out of the installed web app.
   */
  KUKUROO_NAVIGATE_ORIGIN?: string;

  /**
   * Optional. Comma-separated exact origins whose pages may call
   * `<prefix>/subscribe` and `<prefix>/public-key` from the browser, e.g.
   * "https://www.example.com". Unset, no CORS headers are sent, which is the
   * right default when the enrollment page lives on this Worker's own origin.
   *
   * `<prefix>/send` is never CORS-enabled regardless of this list: the send
   * token is a server secret, and a browser page that holds one is a leak in
   * progress, so that mistake should fail on its first test.
   */
  KUKUROO_ALLOWED_ORIGINS?: string;
}
