import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { connect, type ClientHttp2Session, constants } from "node:http2";

/** The server's APNs signing key (a `.p8` from the Apple Developer account) and what it's for. */
export type ApnsOptions = {
  /** The key file's contents, PEM. */
  readonly key: string;
  readonly keyId: string;
  readonly teamId: string;
  /** The app's bundle id, which APNs calls the topic. */
  readonly bundleId: string;
  /** For tests: where to reach APNs instead of Apple's hosts. */
  readonly origins?: { readonly production: string; readonly sandbox: string };
};

export type ApnsEnvironment = "production" | "sandbox";

/** What reaches the app: the alert, and Nudge's own keys for opening the room. */
export type ApnsNotification = {
  readonly title: string;
  readonly body: string;
  /** Notifications with the same one replace each other; at most 64 bytes. */
  readonly collapseId: string;
  /** Groups notifications in Notification Center. */
  readonly threadId: string;
  readonly data: Readonly<Record<string, string>>;
};

const ORIGINS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

/** Apple refuses a token older than an hour and one renewed more often than every 20 minutes. */
const TOKEN_LIFETIME_MS = 40 * 60_000;

/**
 * Sends alerts through APNs over HTTP/2, authenticated with a token signed by the server's key.
 * One connection per environment, opened on first use and again after Apple closes it.
 */
export class Apns {
  private readonly key: KeyObject;
  private token: { value: string; at: number } | undefined;
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly options: ApnsOptions) {
    this.key = createPrivateKey(options.key);
    if (this.key.asymmetricKeyType !== "ec") throw new Error("The APNs key is not an EC key");
  }

  /**
   * Sends one alert. `gone` means the device token no longer works (the app was removed, or the
   * token is for the other environment), so it should be forgotten; other failures throw.
   */
  async send(
    device: string,
    environment: ApnsEnvironment,
    notification: ApnsNotification,
  ): Promise<"sent" | "gone"> {
    if (!/^[0-9a-f]{16,200}$/i.test(device)) return "gone";
    const body = JSON.stringify({
      aps: {
        alert: { title: notification.title, body: notification.body },
        sound: "default",
        "thread-id": notification.threadId,
      },
      ...notification.data,
    });
    const { status, reason } = await this.post(environment, `/3/device/${device}`, body, {
      authorization: `bearer ${this.bearer()}`,
      "apns-topic": this.options.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 86_400),
      "apns-collapse-id": clipBytes(notification.collapseId, 64),
    });
    if (status === 200) return "sent";
    if (status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")
      return "gone";
    // A token Apple refused, as after a clock jump: sign a new one next time.
    if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")
      this.token = undefined;
    throw new Error(`APNs answered ${status}${reason === undefined ? "" : `: ${reason}`}`);
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  /** The provider token (ES256 JWT), signed again every 40 minutes. */
  private bearer(now = Date.now()): string {
    if (this.token !== undefined && now - this.token.at < TOKEN_LIFETIME_MS)
      return this.token.value;
    const header = encode({ alg: "ES256", kid: this.options.keyId });
    const claims = encode({ iss: this.options.teamId, iat: Math.floor(now / 1000) });
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
      key: this.key,
      dsaEncoding: "ieee-p1363",
    });
    const value = `${header}.${claims}.${signature.toString("base64url")}`;
    this.token = { value, at: now };
    return value;
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const origin = (this.options.origins ?? ORIGINS)[environment];
    const open = this.sessions.get(origin);
    if (open !== undefined && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    const forget = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("close", forget);
    session.on("goaway", forget);
    session.on("error", forget);
    // No pushes going out shouldn't keep the process alive.
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private post(
    environment: ApnsEnvironment,
    path: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      const request = this.session(environment).request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: path,
        "content-type": "application/json",
        ...headers,
      });
      request.setTimeout(10_000, () => request.close(constants.NGHTTP2_CANCEL));
      let status = 0;
      const chunks: Buffer[] = [];
      request.on("response", (response) => {
        status = Number(response[constants.HTTP2_HEADER_STATUS]);
      });
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("error", reject);
      request.on("close", () => {
        if (status === 0) return reject(new Error("APNs closed the request"));
        let reason: string | undefined;
        try {
          reason = (JSON.parse(Buffer.concat(chunks).toString()) as { reason?: string }).reason;
        } catch {
          // 200 has no body.
        }
        resolve({ status, reason });
      });
      request.end(body);
    });
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function clipBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  return bytes.length <= max ? text : bytes.subarray(0, max).toString().replace(/�$/, "");
}
