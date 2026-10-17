import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Pushes through a relay are encrypted for the device, so the relay, Apple and Google see only
 * ciphertext: AES-256-GCM under a key from X25519 between a key made for this push alone and the
 * device's, through HKDF-SHA256, as federation does between hosts. Written as one string,
 * `v1.<epk>.<iv>.<data>.<tag>`, all base64url, to fit a push's data field.
 */
const INFO = Buffer.from("nudge push v1");

/** A device's X25519 key pair: the public key as its 32 bytes, base64url, the private one as PKCS #8 PEM. */
export function newDeviceKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ format: "jwk" }).x!,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
}

/** Whether `key` is an X25519 public key: 32 bytes, base64url. */
export function isDeviceKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, "base64url").length === 32;
}

export function sealForDevice(deviceKey: string, payload: unknown): string {
  const ephemeral = generateKeyPairSync("x25519");
  const epk = ephemeral.publicKey.export({ format: "jwk" }).x!;
  const key = derive(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519(deviceKey) }),
    epk,
    deviceKey,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${epk}.${deviceKey}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return ["v1", epk, iv, data, cipher.getAuthTag()]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** What `sealed` holds, if it was sealed for the device with `privateKey`; undefined otherwise. */
export function openOnDevice(privateKey: string, sealed: string): unknown {
  try {
    const [version, epk, iv, data, tag] = sealed.split(".");
    if (version !== "v1" || epk === undefined || iv === undefined || data === undefined)
      return undefined;
    const own = createPrivateKey(privateKey);
    const deviceKey = createPublicKey(own).export({ format: "jwk" }).x!;
    const key = derive(diffieHellman({ privateKey: own, publicKey: x25519(epk) }), epk, deviceKey);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`${epk}.${deviceKey}`));
    decipher.setAuthTag(Buffer.from(tag ?? "", "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return undefined;
  }
}

function x25519(key: string) {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: key }, format: "jwk" });
}

function derive(secret: Buffer, epk: string, deviceKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(`${epk}.${deviceKey}`), INFO, 32));
}
