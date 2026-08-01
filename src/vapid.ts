/**
 * VAPID: the ES256 JWT that identifies this sender to the push service.
 *
 * RFC 8292. One signature per send. The `Authorization: vapid t=…, k=…` header
 * carries the token and the sender's public key, and the push service checks
 * that the key matches the one the subscription was created with.
 *
 * That last sentence is the whole reason the README says never to rotate the
 * keypair: a new key does not invalidate anything visibly, it just stops
 * matching, and every send is accepted-then-dropped for the rest of time.
 */

import { b64urlDecode, b64urlEncode, utf8 } from "./bytes.ts";

/**
 * Import the configured private key and check it against the configured public
 * key.
 *
 * Three encodings are accepted, because "which format is the VAPID private key
 * in" has no single answer across the tools people generate one with:
 *
 *   - base64url of the 32-byte scalar `d`, which is what the `web-push` family
 *     of tools emits, and needs `x`/`y` supplied from the public key;
 *   - a JWK, as JSON;
 *   - PKCS#8 DER, base64 or base64url encoded.
 *
 * The mismatch check at the end is not decoration. A public var and a private
 * secret drawn from two different keypairs is a configuration that deploys
 * cleanly, sends cleanly, returns 201 cleanly, and delivers nothing ever. It is
 * indistinguishable from the rotation failure the README warns about, and it is
 * far easier to do by accident.
 */
export async function importVapidPrivateKey(
  privateKeyMaterial: string,
  publicKeyB64: string,
): Promise<CryptoKey> {
  const pub = b64urlDecode(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(
      `KUKUROO_VAPID_PUBLIC must be the base64url uncompressed P-256 point ` +
        `(65 bytes starting 0x04); got ${pub.length} bytes.`,
    );
  }
  const pubX = b64urlEncode(pub.slice(1, 33));
  const pubY = b64urlEncode(pub.slice(33, 65));

  const material = privateKeyMaterial.trim();
  let key: CryptoKey;

  if (material.startsWith("{")) {
    key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(material) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
  } else {
    const raw = b64urlDecode(material.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
    if (raw.length === 32) {
      key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", d: b64urlEncode(raw), x: pubX, y: pubY, ext: true },
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign"],
      );
    } else {
      key = await crypto.subtle.importKey(
        "pkcs8",
        raw as unknown as BufferSource,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign"],
      );
    }
  }

  const roundTripped = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (roundTripped.x !== pubX || roundTripped.y !== pubY) {
    throw new Error(
      "KUKUROO_VAPID_PRIVATE and KUKUROO_VAPID_PUBLIC are not the same keypair. " +
        "Sends would be accepted by the push service and silently never delivered. " +
        "Fix the pair; do not generate a new one if any device is already enrolled.",
    );
  }

  return key;
}

/**
 * Sign one VAPID token for one push endpoint.
 *
 * `aud` is the endpoint's origin, not the endpoint. `exp` must be inside 24
 * hours; twelve is the conventional value and leaves room for clock skew at
 * both ends. `sub` must be a `mailto:` or `https:` URI: Apple rejects the token
 * outright without one, with a 400 that says nothing useful.
 */
export async function signVapidToken(
  privateKey: CryptoKey,
  audience: string,
  subject: string,
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };

  const signingInput =
    b64urlEncode(utf8(JSON.stringify(header))) + "." + b64urlEncode(utf8(JSON.stringify(payload)));

  // Web Crypto emits the raw r‖s pair for P-256, which is exactly what JWS
  // ES256 wants. No DER unwrapping.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      utf8(signingInput) as unknown as BufferSource,
    ),
  );

  return signingInput + "." + b64urlEncode(signature);
}
