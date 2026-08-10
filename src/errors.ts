/**
 * The one distinction the HTTP layer cannot make for itself.
 *
 * A send fails either because of what the caller sent or because of how the
 * deployment is configured, and both arrive at the route handler as a thrown
 * Error. Collapsing them into one status is what makes a missing secret look
 * like a malformed body: a caller following the documented contract reads 400,
 * treats it as its own fault, rewrites its notification, and never learns that
 * the Worker is missing a key.
 *
 * So the caller's mistakes are thrown as this, and everything else is a
 * deployment fault the sender cannot fix by trying again.
 */
export class InvalidRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}
