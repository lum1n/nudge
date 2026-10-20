import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

/** A JSON payload and its Ed25519 signature, both base64url, so nothing needs canonical JSON. */
export type Signed = { readonly payload: string; readonly signature: string };

/**
 * A signed message only its recipient can read: encrypted with AES-256-GCM under a key from
 * X25519 between a key made for this message alone and the recipient's, through HKDF-SHA256.
 * All base64url.
 */
export type Sealed = {
  readonly v: 1;
  /** The message's own public key. */
  readonly epk: string;
  readonly iv: string;
  readonly data: string;
  readonly tag: string;
};

const INFO = Buffer.from("nudge federation v1");

/** A new private key, as PKCS #8 PEM: Ed25519 to sign, X25519 to be written to. */
export function newKey(type: "ed25519" | "x25519"): string {
  return generateKeyPairSync(type as "ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
}

/** The public half of `privateKey`: its 32 bytes, base64url, as a JWK's `x`. */
export function publicKeyOf(privateKey: string): string {
  return createPublicKey(createPrivateKey(privateKey)).export({ format: "jwk" }).x!;
}

function publicKey(curve: "Ed25519" | "X25519", x: string) {
  return createPublicKey({ key: { kty: "OKP", crv: curve, x }, format: "jwk" });
}

export function signPayload(signingKey: string, payload: unknown): Signed {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    payload: bytes.toString("base64url"),
    signature: sign(null, bytes, createPrivateKey(signingKey)).toString("base64url"),
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

/** What `signed` says if the Ed25519 key `signer` signed it; undefined otherwise. */
export function checkSigned(signer: string, signed: Signed): unknown {
  try {
    const bytes = Buffer.from(signed.payload, "base64url");
    const signature = Buffer.from(signed.signature, "base64url");
    if (!verify(null, bytes, publicKey("Ed25519", signer), signature)) return undefined;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Signs `payload` with `signingKey`, then encrypts it for the X25519 key `recipient`. */
export function seal(signingKey: string, recipient: string, payload: unknown): Sealed {
  const signed = Buffer.from(JSON.stringify(signPayload(signingKey, payload)));
  const ephemeral = generateKeyPairSync("x25519");
  const epk = ephemeral.publicKey.export({ format: "jwk" }).x!;
  const key = derive(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKey("X25519", recipient) }),
    epk,
    recipient,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${epk}.${recipient}`));
  const data = Buffer.concat([cipher.update(signed), cipher.final()]);
  return {
    v: 1,
    epk,
    iv: iv.toString("base64url"),
    data: data.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

/**
 * The signed message inside `sealed`, if it was encrypted for the X25519 key `privateKey`;
 * undefined otherwise. The signature is the caller's to check.
 */
export function open(privateKey: string, sealed: Sealed): Signed | undefined {
  try {
    const own = createPrivateKey(privateKey);
    const recipient = publicKeyOf(privateKey);
    const key = derive(
      diffieHellman({ privateKey: own, publicKey: publicKey("X25519", sealed.epk) }),
      sealed.epk,
      recipient,
    );
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
    decipher.setAAD(Buffer.from(`${sealed.epk}.${recipient}`));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64url")),
      decipher.final(),
    ]);
    const signed = JSON.parse(plain.toString("utf8")) as Signed;
    return typeof signed.payload === "string" && typeof signed.signature === "string"
      ? signed
      : undefined;
  } catch {
    return undefined;
  }
}

function derive(secret: Buffer, epk: string, recipient: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(`${epk}.${recipient}`), INFO, 32));
}
