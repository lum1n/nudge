import { createHash } from "node:crypto";
import type { Context as HonoContext, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/** A token bucket: up to `burst` requests at once, then `perSecond` more each second. */
export type Rate = { readonly burst: number; readonly perSecond: number };

export type RateLimits = {
  /** Every request from one address, signed in or not. */
  readonly address: Rate;
  /** Every request with one bearer token, whatever the address. */
  readonly token: Rate;
  /** Guessing codes from one address: pairing, setup and starting a sign-in. */
  readonly attempts: Rate;
};

export const DEFAULT_RATE_LIMITS: RateLimits = {
  address: { burst: 1200, perSecond: 20 },
  token: { burst: 300, perSecond: 5 },
  // A pairing code has 40 bits and lasts ten minutes: two tries a minute find nothing.
  attempts: { burst: 10, perSecond: 1 / 30 },
};

/** The largest REST body, but for extension routes, which have limits of their own. */
export const MAX_REST_BODY = 1024 * 1024;

/** Buckets kept per limit; past it, full ones go first, then the oldest. */
const MAX_KEYS = 10_000;

/** In-memory token buckets by key. A restart forgets them. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly rate: Rate,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one request for `key`: 0 when it may go ahead, else the seconds until it may. */
  take(key: string): number {
    const now = this.now();
    const { burst, perSecond } = this.rate;
    const found = this.buckets.get(key);
    const tokens =
      found === undefined
        ? burst
        : Math.min(burst, found.tokens + ((now - found.at) / 1000) * perSecond);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return Math.max(1, Math.ceil((1 - tokens) / perSecond));
    }
    // Re-inserted, so the map stays in order of last use.
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.buckets.size > MAX_KEYS) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    const { burst, perSecond } = this.rate;
    for (const [key, bucket] of this.buckets)
      if (bucket.tokens + ((now - bucket.at) / 1000) * perSecond >= burst) this.buckets.delete(key);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= MAX_KEYS) break;
      this.buckets.delete(key);
    }
  }
}

export type LimitOptions = {
  readonly limits: RateLimits;
  /** The address the request came from, as the runtime sees it; undefined when unknown. */
  readonly peerAddress: (c: HonoContext) => string | undefined;
  /** Whether a proxy in front adds the caller's address to `X-Forwarded-For`. */
  readonly trustProxy: () => boolean;
  readonly now?: () => number;
};

/**
 * Rate limits for protocol v1: one middleware for every route (per address and per token), and a
 * stricter one per address for the routes that take a code anyone could guess. Over a limit is a
 * 429 with `Retry-After`. `/v1/health` is never limited.
 */
export function rateLimits(options: LimitOptions): {
  readonly all: MiddlewareHandler;
  readonly attempts: MiddlewareHandler;
} {
  const address = new RateLimiter(options.limits.address, options.now);
  const token = new RateLimiter(options.limits.token, options.now);
  const attempts = new RateLimiter(options.limits.attempts, options.now);
  const addressOf = (c: HonoContext) =>
    clientAddress(c.req.raw, options.peerAddress(c), options.trustProxy());

  const tooMany = (c: HonoContext, seconds: number) => {
    c.header("Retry-After", String(seconds));
    return c.json({ error: `Too many requests; try again in ${seconds} s` }, 429);
  };

  return {
    all: async (c, next) => {
      if (c.req.path === "/v1/health") return next();
      const wait = address.take(addressOf(c));
      if (wait > 0) return tooMany(c, wait);
      const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      if (bearer !== undefined) {
        const waitToken = token.take(createHash("sha256").update(bearer).digest("base64url"));
        if (waitToken > 0) return tooMany(c, waitToken);
      }
      await next();
    },
    attempts: async (c, next) => {
      if (c.req.method === "GET" || c.req.method === "HEAD") return next();
      const wait = attempts.take(addressOf(c));
      if (wait > 0) return tooMany(c, wait);
      await next();
    },
  };
}

/** A 413 for a body over `maxSize` bytes, before the route reads it. */
export function limitBody(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: `The body is over ${maxSize} bytes` }, 413),
  });
}

/**
 * Who to count a request against: the address that reached the server or, behind a proxy it
 * trusts, the one the proxy last added to `X-Forwarded-For` (anything before it the caller can
 * write). IPv6 addresses count by their /64, which one machine usually has whole.
 */
export function clientAddress(
  request: Request,
  peer: string | undefined,
  trustProxy: boolean,
): string {
  const forwarded = trustProxy
    ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || undefined
    : undefined;
  const address = forwarded ?? peer;
  return address === undefined || address === "" ? "unknown" : addressKey(address);
}

function addressKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return mapped;
  if (!address.includes(":")) return address;
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const [head = "", tail] = bare.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => (Number.parseInt(group, 16) || 0).toString(16))
    .join(":")}::/64`;
}
