import { createPrivateKey, type KeyObject, sign } from "node:crypto";

/** The fields of a Firebase service account's JSON key that sending needs. */
export type ServiceAccount = {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
};

export type FcmOptions = {
  readonly serviceAccount: ServiceAccount;
  /** For tests: where to reach FCM instead of Google's host. */
  readonly origin?: string;
  readonly fetch?: typeof fetch;
};

/** What reaches the app: only data, so the app builds the notification and its link itself. */
export type FcmMessage = {
  /** Notifications with the same one replace each other while the device is offline. */
  readonly collapseKey: string;
  readonly data: Readonly<Record<string, string>>;
};

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

/**
 * Sends data messages through FCM's HTTP v1 API, with an OAuth access token the server gets for
 * its service account and keeps until shortly before it expires.
 */
export class Fcm {
  private readonly key: KeyObject;
  private access: Promise<{ token: string; until: number }> | undefined;

  constructor(private readonly options: FcmOptions) {
    const account = options.serviceAccount;
    if (!account.project_id || !account.client_email || !account.private_key)
      throw new Error("The FCM service account needs project_id, client_email and private_key");
    this.key = createPrivateKey(account.private_key);
  }

  /**
   * Sends one message. `gone` means the registration token no longer works (the app was removed
   * or its data cleared), so it should be forgotten; other failures throw.
   */
  async send(device: string, message: FcmMessage): Promise<"sent" | "gone"> {
    const origin = this.options.origin ?? "https://fcm.googleapis.com";
    const project = encodeURIComponent(this.options.serviceAccount.project_id);
    const response = await this.fetch(`${origin}/v1/projects/${project}/messages:send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: device,
          data: message.data,
          android: { priority: "high", collapse_key: message.collapseKey, ttl: "86400s" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "sent";
    const text = await response.text();
    let code: string | undefined;
    try {
      const error = (JSON.parse(text) as { error?: FcmError }).error;
      code = error?.details?.find((d) => d.errorCode !== undefined)?.errorCode ?? error?.status;
    } catch {
      // Not JSON; reported below.
    }
    if (response.status === 404 || code === "UNREGISTERED") return "gone";
    if (response.status === 400 && code === "INVALID_ARGUMENT" && /token/i.test(text))
      return "gone";
    if (response.status === 401) this.access = undefined;
    throw new Error(`FCM answered ${response.status}: ${code ?? text.slice(0, 200)}`);
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(url, init);
  }

  private accessToken(): Promise<string> {
    const now = Date.now();
    const current = this.access;
    if (current !== undefined)
      return current.then((access) =>
        access.until > Date.now() ? access.token : this.renew(now).then((a) => a.token),
      );
    return this.renew(now).then((access) => access.token);
  }

  private renew(now: number): Promise<{ token: string; until: number }> {
    const access = this.exchange(now);
    this.access = access;
    // A failed exchange is tried again on the next push.
    access.catch(() => {
      if (this.access === access) this.access = undefined;
    });
    return access;
  }

  /** The service account's signed assertion, traded for an access token (RFC 7523). */
  private async exchange(now: number): Promise<{ token: string; until: number }> {
    const account = this.options.serviceAccount;
    const tokenUri = account.token_uri ?? TOKEN_URI;
    const iat = Math.floor(now / 1000);
    const header = encode({ alg: "RS256", typ: "JWT" });
    const claims = encode({
      iss: account.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    });
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), this.key);
    const response = await this.fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${signature.toString("base64url")}`,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        `Google refused the FCM service account: ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    const body = (await response.json()) as { access_token: string; expires_in?: number };
    // Renewed five minutes early.
    return { token: body.access_token, until: now + ((body.expires_in ?? 3600) - 300) * 1000 };
  }
}

type FcmError = { status?: string; details?: { errorCode?: string }[] };

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
