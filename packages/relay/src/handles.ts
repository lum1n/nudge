import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** A device as APNs or FCM knows it. */
export type DeviceToken = {
  readonly platform: "apns" | "fcm";
  readonly token: string;
  /** APNs only: apps built for development take pushes through Apple's sandbox. */
  readonly environment?: "production" | "sandbox";
};

/**
 * Handles stand in for device tokens: a host that has one can push to the device through the
 * relay, but can't read the token or make a handle of its own. Each is the token encrypted with
 * AES-256-GCM under a key only the relay has, so the relay keeps no list of devices, and a
 * handle that decrypts was made by it.
 */
export class Handles {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("The handle key is not 32 bytes");
  }

  make(device: DeviceToken): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([
      cipher.update(
        JSON.stringify({ p: device.platform, t: device.token, e: device.environment }),
        "utf8",
      ),
      cipher.final(),
    ]);
    return `h1.${Buffer.concat([iv, data, cipher.getAuthTag()]).toString("base64url")}`;
  }

  /** The device behind `handle`; undefined for one this relay didn't make, or made under another key. */
  read(handle: string): DeviceToken | undefined {
    if (!handle.startsWith("h1.") || handle.length > MAX_HANDLE) return undefined;
    try {
      const bytes = Buffer.from(handle.slice(3), "base64url");
      if (bytes.length < 12 + 16 + 1) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      const plain = Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]);
      const { p, t, e } = JSON.parse(plain.toString("utf8")) as {
        p: string;
        t: string;
        e?: string;
      };
      if ((p !== "apns" && p !== "fcm") || typeof t !== "string") return undefined;
      return {
        platform: p,
        token: t,
        ...(e === "production" || e === "sandbox" ? { environment: e } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

const AAD = Buffer.from("nudge relay handle v1");

/** Longest handle: an FCM token is at most a few hundred bytes. */
export const MAX_HANDLE = 8192;
