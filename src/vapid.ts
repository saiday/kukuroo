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

import { b64urlDecode, b64urlEncode, concat, utf8 } from "./bytes.ts";

export interface VapidKeys {
  privateKey: CryptoKey;
  /** base64url uncompressed P-256 point, for the `k=` parameter and the client. */
  publicKeyB64: string;
}

/**
 * Import the VAPID keypair from whatever the operator stored.
 *
 * Three encodings are accepted, because "which format is the VAPID private key
 * in" has no single answer across the tools people generate one with:
 *
 *   - a JWK, as JSON. **Preferred**, because a JWK carries `x` and `y`, so the
 *     public key is derivable and does not have to be configured separately.
 *   - PKCS#8 DER, base64 or base64url encoded. Also self-describing.
 *   - base64url of the bare 32-byte scalar `d`, which is what the `web-push`
 *     family of tools emits. This one carries no public half, so it is the only
 *     case where `KUKUROO_VAPID_PUBLIC` must also be set.
 *
 * When a public key *is* supplied, it is checked against the private one rather
 * than trusted. That check is not decoration: a public var and a private secret
 * drawn from two different keypairs is a configuration that deploys cleanly,
 * sends cleanly, returns 201 cleanly, and delivers nothing ever. It is
 * indistinguishable from the rotation failure the README warns about, and far
 * easier to do by accident.
 *
 * Supplying no public key at all is better still, because then the two cannot
 * disagree.
 */
export async function importVapidKeys(
  privateKeyMaterial: string,
  publicKeyB64?: string,
): Promise<VapidKeys> {
  const material = privateKeyMaterial.trim();
  let key: CryptoKey;

  if (material.startsWith("{")) {
    key = await importJwk(JSON.parse(material) as JsonWebKey);
  } else {
    const raw = b64urlDecode(material.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
    if (raw.length === 32) {
      if (publicKeyB64 === undefined) {
        throw new Error(
          "KUKUROO_VAPID_PRIVATE is a bare 32-byte scalar, which does not carry its own " +
            "public half, so KUKUROO_VAPID_PUBLIC must also be set. Storing the key as a " +
            "JWK instead removes the need for a second value, and with it the chance of " +
            "the two disagreeing.",
        );
      }
      const { x, y } = splitPublicKey(publicKeyB64);
      key = await importJwk({ kty: "EC", crv: "P-256", d: b64urlEncode(raw), x, y, ext: true });
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

  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("VAPID private key did not yield a public point; is it a P-256 EC key?");
  }

  if (publicKeyB64 !== undefined) {
    const supplied = splitPublicKey(publicKeyB64);
    if (jwk.x !== supplied.x || jwk.y !== supplied.y) {
      throw new Error(
        "KUKUROO_VAPID_PRIVATE and KUKUROO_VAPID_PUBLIC are not the same keypair. " +
          "Sends would be accepted by the push service and silently never delivered. " +
          "Fix the pair; do not generate a new one if any device is already enrolled.",
      );
    }
  }

  return {
    privateKey: key,
    publicKeyB64: b64urlEncode(
      concat([0x04], b64urlDecode(jwk.x), b64urlDecode(jwk.y)),
    ),
  };
}

function importJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
}

function splitPublicKey(publicKeyB64: string): { x: string; y: string } {
  const pub = b64urlDecode(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(
      `KUKUROO_VAPID_PUBLIC must be the base64url uncompressed P-256 point ` +
        `(65 bytes starting 0x04); got ${pub.length} bytes.`,
    );
  }
  return { x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)) };
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
