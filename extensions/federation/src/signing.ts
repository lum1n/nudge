import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/** A JSON payload and its Ed25519 signature, both base64url, so nothing needs canonical JSON. */
export type Signed = { readonly payload: string; readonly signature: string };

/** A new Ed25519 private key, as PKCS #8 PEM. */
export function newKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
}

/** The public half of `privateKey`: its 32 bytes, base64url, as a JWK's `x`. */
export function publicKeyOf(privateKey: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKey)).export({ format: "jwk" });
  return jwk.x!;
}

export function seal(privateKey: string, payload: unknown): Signed {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    payload: bytes.toString("base64url"),
    signature: sign(null, bytes, createPrivateKey(privateKey)).toString("base64url"),
  };
}

/** What `signed` says, read without checking it, such as to learn whose key to check it with. */
export function peek(signed: Signed): unknown {
  try {
    return JSON.parse(Buffer.from(signed.payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** What `signed` says if `publicKey` signed it; undefined otherwise. */
export function unseal(publicKey: string, signed: Signed): unknown {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    });
    const bytes = Buffer.from(signed.payload, "base64url");
    if (!verify(null, bytes, key, Buffer.from(signed.signature, "base64url"))) return undefined;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}
