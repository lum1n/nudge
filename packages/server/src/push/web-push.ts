import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/** The server's VAPID key pair (RFC 8292), base64url: the public key raw and uncompressed, the private key's `d`. */
export type VapidKeys = { readonly publicKey: string; readonly privateKey: string };

/** Where a browser takes pushes, as `PushSubscription.toJSON()` gives it. */
export type PushTarget = {
  readonly endpoint: string;
  /** The browser's P-256 key, base64url, and its 16-byte auth secret, base64url. */
  readonly keys: { readonly p256dh: string; readonly auth: string };
};

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const d = privateKey.export({ format: "jwk" }).d!;
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  return { publicKey: raw.toString("base64url"), privateKey: d };
}

/** Record size; one record holds a whole push, which push services cap at 4 kB anyway. */
const RECORD_SIZE = 4096;

/**
 * Encrypts `payload` for one browser (RFC 8291, `aes128gcm`), so the push service in between
 * can't read it.
 */
export function encryptPayload(target: PushTarget, payload: Uint8Array): Buffer {
  const receiver = Buffer.from(target.keys.p256dh, "base64url");
  const authSecret = Buffer.from(target.keys.auth, "base64url");
  if (receiver.length !== 65 || receiver[0] !== 4) throw new Error("Bad p256dh key");
  if (authSecret.length !== 16) throw new Error("Bad auth secret");
  const ecdh = createECDH("prime256v1");
  const sender = ecdh.generateKeys();
  const shared = ecdh.computeSecret(receiver);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const salt = randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  // A single, last record: the payload, then the 0x02 delimiter.
  if (payload.length + 1 + 16 > RECORD_SIZE) throw new Error("Push payload too large");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(payload),
    cipher.update(Buffer.from([2])),
    cipher.final(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(sender.length, 20);
  return Buffer.concat([header, sender, body, cipher.getAuthTag()]);
}

/** HKDF-SHA-256 with one expand round, enough for up to 32 bytes. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

/** The `Authorization` header for one push service (RFC 8292), valid for 12 hours. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = Date.now(),
): string {
  const header = encode({ typ: "JWT", alg: "ES256" });
  const claims = encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  });
  const raw = Buffer.from(keys.publicKey, "base64url");
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export type PushOptions = {
  readonly vapid: VapidKeys;
  /** A `mailto:` or `https:` address push services can reach the server's owner at. */
  readonly subject: string;
  /** Seconds the push service keeps it for a browser that is offline. Default a day. */
  readonly ttl?: number;
  readonly urgency?: "very-low" | "low" | "normal" | "high";
  readonly fetch?: typeof fetch;
};

/**
 * Sends one push. `gone` means the browser dropped the subscription (404 or 410), so it should be
 * forgotten; other failures throw.
 */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  options: PushOptions,
): Promise<"sent" | "gone"> {
  const body = encryptPayload(target, Buffer.from(JSON.stringify(payload)));
  const response = await (options.fetch ?? fetch)(target.endpoint, {
    method: "POST",
    headers: {
      authorization: vapidAuthorization(target.endpoint, options.vapid, options.subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttl ?? 86_400),
      urgency: options.urgency ?? "normal",
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 || response.status === 410) return "gone";
  if (!response.ok)
    throw new Error(
      `Push service answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  return "sent";
}
