import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type RunningServer, serveNudge } from "../src/index.ts";
import { clientAddress, MAX_REST_BODY, RateLimiter } from "../src/v1/limits.ts";

const context = BACKGROUND_CONTEXT;
const client = { name: "test", version: "1", platform: "node" };

describe("RateLimiter", () => {
  it("lets a burst through, then one request per refill, and says how long to wait", () => {
    let now = 0;
    const limiter = new RateLimiter({ burst: 2, perSecond: 0.5 }, () => now);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(2);
    expect(limiter.take("b")).toBe(0);
    now = 1000;
    expect(limiter.take("a")).toBe(1);
    now = 2000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(2);
  });
});

describe("clientAddress", () => {
  const request = (forwarded?: string) =>
    new Request("http://robin.test/v1", {
      headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    });

  it("ignores X-Forwarded-For unless told a proxy is in front", () => {
    expect(clientAddress(request("1.2.3.4"), "10.0.0.1", false)).toBe("10.0.0.1");
    expect(clientAddress(request(), undefined, false)).toBe("unknown");
  });

  it("believes only the entry the proxy added, the last", () => {
    expect(clientAddress(request("6.6.6.6, 1.2.3.4"), "10.0.0.1", true)).toBe("1.2.3.4");
    expect(clientAddress(request(), "10.0.0.1", true)).toBe("10.0.0.1");
  });

  it("counts IPv6 by its /64, and IPv4 mapped into IPv6 as IPv4", () => {
    expect(clientAddress(request(), "2001:db8:1:2:aaaa::1", false)).toBe("2001:db8:1:2::/64");
    expect(clientAddress(request(), "2001:db8:1:2:bbbb:cccc:dddd:eeee", false)).toBe(
      "2001:db8:1:2::/64",
    );
    expect(clientAddress(request(), "2001:db8::1", false)).toBe("2001:db8:0:0::/64");
    expect(clientAddress(request(), "::1", false)).toBe("0:0:0:0::/64");
    expect(clientAddress(request(), "::ffff:127.0.0.1", false)).toBe("127.0.0.1");
  });
});

describe("v1 rate and body limits", () => {
  let nudge: Nudge;
  let token: string;
  let playerId: string;

  beforeEach(async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
      context,
    );
    const invited = await nudge.players.invite("Ada", context);
    token = invited.token;
    playerId = invited.player.id;
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  /** An app that takes the caller's address from `x-peer`, as a runtime would from its socket. */
  const appWith = (options: Parameters<typeof createApp>[0]["limits"], trustProxy = false) =>
    createApp({
      assistants: new Map([["robin", nudge]]),
      limits: options,
      trustProxy,
      peerAddress: (c) => c.req.header("x-peer"),
      onError: (error) => {
        throw error;
      },
    });

  const pair = (app: Hono, code: string, headers: Record<string, string> = {}) =>
    app.request("/v1/a/robin/pair", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ code, client }),
    });

  it("limits guessing pairing codes per address, and spoofed X-Forwarded-For doesn't help", async () => {
    const app = appWith({ attempts: { burst: 3, perSecond: 1 / 60 } });
    for (let n = 0; n < 3; n++)
      expect((await pair(app, "AAAA-AAAA", { "x-peer": "10.0.0.1" })).status).toBe(401);
    const limited = await pair(app, "AAAA-AAAA", {
      "x-peer": "10.0.0.1",
      "x-forwarded-for": "9.9.9.9",
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await limited.json()) as { error: string }).error).toMatch(/Too many requests/);
    // Even a right code waits: the limit comes before the code is checked.
    const { code } = await nudge.players.pairingCode(playerId, context);
    expect((await pair(app, code, { "x-peer": "10.0.0.1" })).status).toBe(429);
    expect((await pair(app, code, { "x-peer": "10.0.0.2" })).status).toBe(200);
    // Signed-in routes are not counted as attempts.
    const me = await app.request("/v1/a/robin/me", {
      headers: { authorization: `Bearer ${token}`, "x-peer": "10.0.0.1" },
    });
    expect(me.status).toBe(200);
  });

  it("counts the proxy's address for the caller when it trusts the proxy", async () => {
    const app = appWith({ attempts: { burst: 1, perSecond: 1 / 60 } }, true);
    const proxy = { "x-peer": "10.0.0.1" };
    expect((await pair(app, "AAAA-AAAA", { ...proxy, "x-forwarded-for": "1.1.1.1" })).status).toBe(
      401,
    );
    expect((await pair(app, "AAAA-AAAA", { ...proxy, "x-forwarded-for": "1.1.1.1" })).status).toBe(
      429,
    );
    expect((await pair(app, "AAAA-AAAA", { ...proxy, "x-forwarded-for": "2.2.2.2" })).status).toBe(
      401,
    );
  });

  it("limits starting sign-ins per address too", async () => {
    const app = appWith({ attempts: { burst: 2, perSecond: 1 / 60 } });
    const start = () => app.request("/v1/sign-in", { method: "POST", headers: { "x-peer": "a" } });
    expect((await start()).status).toBe(201);
    expect((await start()).status).toBe(201);
    expect((await start()).status).toBe(429);
  });

  it("limits each token, wherever it is used from", async () => {
    const app = appWith({ token: { burst: 2, perSecond: 1 / 60 } });
    const me = (bearer: string, peer: string) =>
      app.request("/v1/a/robin/me", {
        headers: { authorization: `Bearer ${bearer}`, "x-peer": peer },
      });
    expect((await me(token, "a")).status).toBe(200);
    expect((await me(token, "b")).status).toBe(200);
    expect((await me(token, "c")).status).toBe(429);
    const other = await nudge.players.invite("Bo", context);
    expect((await me(other.token, "a")).status).toBe(200);
  });

  it("limits every request per address, but never /v1/health", async () => {
    const app = appWith({ address: { burst: 1, perSecond: 1 / 60 } });
    expect((await app.request("/v1/a", { headers: { "x-peer": "a" } })).status).toBe(200);
    expect((await app.request("/v1/a", { headers: { "x-peer": "a" } })).status).toBe(429);
    for (let n = 0; n < 3; n++)
      expect((await app.request("/v1/health", { headers: { "x-peer": "a" } })).status).not.toBe(
        429,
      );
  });

  it("refuses a body over the limit with a 413", async () => {
    const app = appWith({});
    const remember = (text: string) =>
      app.request("/v1/a/robin/me/memory", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    const big = await remember("x".repeat(MAX_REST_BODY));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/over/);
    expect((await remember("Likes tea")).status).not.toBe(413);
  });

  describe("over Node", () => {
    let server: RunningServer | undefined;
    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    it("counts by the socket's address", async () => {
      server = await serveNudge({
        assistants: new Map([["robin", nudge]]),
        port: 0,
        limits: { attempts: { burst: 1, perSecond: 1 / 60 } },
      });
      const attempt = (forwarded: string) =>
        fetch(`${server!.url}/v1/a/robin/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
          body: JSON.stringify({ code: "AAAA-AAAA", client }),
        });
      expect((await attempt("1.1.1.1")).status).toBe(401);
      expect((await attempt("2.2.2.2")).status).toBe(429);
    });
  });
});
