import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SignInStatusResponse } from "@nudge/protocol";

/** How long a browser's QR code works. */
export const SIGN_IN_TTL_MS = 5 * 60 * 1000;
/** Requests waiting at once; more answer 429, so nobody can fill the server's memory. */
const MAX_WAITING = 500;

type Waiting = {
  readonly secret: Buffer;
  readonly expiresAt: number;
  /** Set once an app signed in approves: whose assistant, and the code the browser pairs with. */
  approved?: { readonly assistant: string; readonly code: string };
};

/**
 * Browsers waiting for an app that is signed in to sign them in, by the QR code on the web UI's
 * sign-in page. The QR code holds only the id: the app approves it with its own token, and the
 * browser learns the answer with the secret it alone got, so a photo of the screen signs nobody
 * in. Kept in memory: a restart only means a new QR code.
 */
export class SignInRequests {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new request, or undefined when too many are waiting. */
  start(): { id: string; secret: string; expiresAt: number } | undefined {
    this.dropExpired();
    if (this.waiting.size >= MAX_WAITING) return undefined;
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + SIGN_IN_TTL_MS;
    this.waiting.set(id, { secret: digest(secret), expiresAt });
    return { id, secret, expiresAt };
  }

  /** What the browser that holds `secret` waits for; undefined for an unknown, expired or wrong one. */
  status(id: string, secret: string): SignInStatusResponse | undefined {
    const request = this.live(id);
    if (request === undefined || !timingSafeEqual(request.secret, digest(secret))) return undefined;
    return request.approved === undefined
      ? { status: "waiting" }
      : { status: "approved", ...request.approved };
  }

  /** Whether an app may approve the request: it is live and not approved yet. */
  pending(id: string): boolean {
    const request = this.live(id);
    return request !== undefined && request.approved === undefined;
  }

  /** Hands the browser `code` for `assistant`; false when the request is gone or approved. */
  approve(id: string, assistant: string, code: string): boolean {
    const request = this.live(id);
    if (request === undefined || request.approved !== undefined) return false;
    request.approved = { assistant, code };
    return true;
  }

  private live(id: string): Waiting | undefined {
    const request = this.waiting.get(id);
    if (request === undefined || request.expiresAt > this.now()) return request;
    this.waiting.delete(id);
    return undefined;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [id, request] of this.waiting) if (request.expiresAt <= now) this.waiting.delete(id);
  }
}

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** `nudge://sign-in?server=…&request=…`, what the web UI's sign-in QR code holds. */
export function signInLink(server: string, id: string): string {
  const query = new URLSearchParams({ server, request: id });
  return `nudge://sign-in?${query.toString()}`;
}
