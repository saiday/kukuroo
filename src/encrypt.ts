/**
 * RFC 8291 message encryption for Web Push, `aes128gcm` content encoding.
 *
 * The push service is an untrusted relay: it sees the endpoint and the ciphertext
 * and nothing else. Only the device that created the subscription can decrypt,
 * because the key derivation is bound to that subscription's ECDH public key and
 * its 16-byte auth secret.
 *
 * Layout of the body we produce, RFC 8188 section 2:
 *
 *   salt (16) ‖ rs (4, big-endian) ‖ idlen (1) ‖ keyid (65) ‖ ciphertext
 *
 * where `keyid` is our ephemeral public key. A fresh ephemeral keypair per
 * message is required, not an optimisation to skip.
 */

import { b64urlDecode, be32, concat, utf8 } from "./bytes.ts";

/** HMAC-SHA256, which is every step of the HKDF below. */
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as unknown as BufferSource));
}

/**
 * The record size we advertise. It must be at least the plaintext plus the
 * padding delimiter plus the 16-byte GCM tag; 4096 covers any payload the
 * ~3,900-byte declarative budget allows, in a single record.
 */
const RECORD_SIZE = 4096;

export interface PushSubscriptionKeys {
  /** base64url uncompressed P-256 point, the device's ECDH public key. */
  p256dh: string;
  /** base64url 16-byte shared auth secret. */
  auth: string;
}

export async function encryptPayload(
  plaintextBody: Uint8Array,
  keys: PushSubscriptionKeys,
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error(`subscription p256dh is not a 65-byte uncompressed point (${uaPublic.length} bytes)`);
  }
  if (authSecret.length !== 16) {
    throw new Error(`subscription auth secret is not 16 bytes (${authSecret.length} bytes)`);
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as unknown as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // `public` is spelled `$public` in @cloudflare/workers-types; the runtime
  // reads the standard name, so the object is built plainly and cast.
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    ),
  );

  // RFC 8291 section 3.4. Two HKDF stages: the first is salted with the
  // subscription's auth secret and mixes in both public keys, which is what
  // binds the message to this subscription; the second is salted with the
  // random per-message salt.
  const prkKey = await hmac(authSecret, sharedSecret);
  const ikm = await hmac(prkKey, concat(utf8("WebPush: info"), [0x00], uaPublic, asPublic, [0x01]));

  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(utf8("Content-Encoding: aes128gcm"), [0x00, 0x01]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(utf8("Content-Encoding: nonce"), [0x00, 0x01]))).slice(0, 12);

  const cekKey = await crypto.subtle.importKey(
    "raw",
    cek as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  // 0x02 is the RFC 8188 padding delimiter for the *last* record. A 0x01 here
  // would tell the receiver another record follows, and decryption fails.
  const padded = concat(plaintextBody, [0x02]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as unknown as BufferSource, tagLength: 128 },
      cekKey,
      padded as unknown as BufferSource,
    ),
  );

  return concat(salt, be32(RECORD_SIZE), [asPublic.length], asPublic, ciphertext);
}
