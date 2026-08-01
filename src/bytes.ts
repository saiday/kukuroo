/**
 * Byte plumbing. base64url in both directions, concatenation, and UTF-8.
 *
 * Web Push is base64url everywhere and standard base64 nowhere, and the two
 * differ by three characters. A subscription key that round-trips through the
 * wrong alphabet decodes to the wrong point on the curve, and the only symptom
 * is a notification that never arrives.
 */

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const chunks = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Four-byte big-endian, for the aes128gcm record-size field. */
export function be32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Accepts base64url and standard base64, padded or not. Subscriptions come from
 * `pushManager.subscribe()` via whatever JSON the client happened to write, and
 * being strict here buys nothing but a class of bug that is invisible until a
 * send fails.
 */
export function b64urlDecode(s: string): Uint8Array {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
