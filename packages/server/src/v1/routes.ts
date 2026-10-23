import { randomBytes } from "node:crypto";
import type { LogFields, ModelErrors, Nudge } from "@nudge/core";
import { CLOSE, type HealthResponse } from "@nudge/protocol";
import { type Context as HonoContext, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { Connection, type ConnectionOptions } from "./connection.ts";
import { ExtensionSocket } from "./extension-socket.ts";
import { Hubs } from "./hub.ts";
import {
  DEFAULT_RATE_LIMITS,
  limitBody,
  MAX_REST_BODY,
  type RateLimits,
  rateLimits,
} from "./limits.ts";
import { type ExtensionSettings, restRoutes } from "./rest.ts";
import { type ServerControl, serverRoutes } from "./server.ts";
import { type SetupControl, setupRoutes } from "./setup.ts";

export { HttpError } from "./rest.ts";

export type V1Options = {
  readonly assistants: ReadonlyMap<string, Nudge>;
  readonly upgradeWebSocket: UpgradeWebSocket;
  readonly version: string;
  /** Told of what fails in the background, with the assistant and room it was for. */
  readonly report: (error: unknown, fields?: LogFields) => void;
  /** The host's last model errors, for `GET /v1/health` and owners at `GET /v1/server`. */
  readonly modelErrors?: Pick<ModelErrors, "recent" | "lastAt">;
  /**
   * The server's address as clients reach it, for pairing links; default each request's origin.
   * Read on every request, since setup may set it.
   */
  readonly publicUrl?: string | (() => string | undefined);
  /** Whether to believe a proxy's `X-Forwarded-*` about the request's origin. */
  readonly trustProxy?: boolean | (() => boolean);
  /**
   * The address a request came from, as the runtime sees it, for rate limits; behind a trusted
   * proxy, `X-Forwarded-For` is believed instead. Without one, every caller counts as one.
   */
  readonly peerAddress?: (c: HonoContext) => string | undefined;
  /** Requests allowed per address, per token and per address on the routes that take codes. */
  readonly limits?: Partial<RateLimits>;
  /** Setting up extensions from the web UI; none without. */
  readonly extensionSettings?: ExtensionSettings;
  /** The server's own API for its owners, at `/v1/server` (ADR 11); absent, it answers 404. */
  readonly server?: ServerControl;
  /** Setup mode, at `/v1/setup`, for a server with no config yet; absent, it answers 404. */
  readonly setup?: SetupControl;
  /** Defaults: 25 s heartbeat, 50 ms between patches, 10 s for the hello. */
  readonly timing?: Partial<Pick<ConnectionOptions, "heartbeatMs" | "flushMs" | "helloTimeoutMs">>;
};

/**
 * Protocol v1, to mount at `/v1`: the HTTP commands, each assistant's socket, and the extensions'
 * own room sockets.
 */
export function v1Routes(options: V1Options): Hono {
  const app = new Hono();
  const { publicUrl: url, trustProxy: trust } = options;
  const publicUrl = typeof url === "function" ? url : () => url;
  const trustProxy = typeof trust === "function" ? trust : () => trust === true;

  const limits = rateLimits({
    limits: { ...DEFAULT_RATE_LIMITS, ...options.limits },
    peerAddress: options.peerAddress ?? (() => undefined),
    trustProxy,
  });
  app.use(limits.all);
  // Where a code is guessed: pairing, setup, and starting a sign-in, which holds a place.
  app.use("/a/:assistant/pair", limits.attempts);
  app.use("/setup", limits.attempts);
  app.use("/setup/*", limits.attempts);
  app.use("/sign-in", limits.attempts);
  // Extension routes check their own limits, which may be larger.
  const restBody = limitBody(MAX_REST_BODY);
  app.use(async (c, next) =>
    /\/a\/[^/]+\/ext(\/|$)/.test(c.req.path) ? next() : restBody(c, next),
  );

  // A new epoch per app, so clients that reconnect after a restart know to subscribe again.
  const epoch = randomBytes(8).toString("base64url");
  const hubs = new WeakMap<Nudge, Hubs>();
  const hubsOf = (nudge: Nudge) => {
    let found = hubs.get(nudge);
    if (found === undefined) {
      const assistant = nameOf(nudge);
      found = new Hubs(nudge, (error, fields) => options.report(error, { assistant, ...fields }));
      hubs.set(nudge, found);
    }
    return found;
  };
  const nameOf = (nudge: Nudge) => {
    for (const [name, open] of options.assistants) if (open === nudge) return name;
    return undefined;
  };

  // For a load balancer or a monitor, without a token: it names nothing and tells no secret.
  app.get("/health", (c) => {
    const last = options.modelErrors?.lastAt();
    return c.json({
      ok: true,
      assistants: options.assistants.size,
      ...(last === undefined
        ? {}
        : { lastModelErrorAgeSeconds: Math.max(0, Math.floor((Date.now() - last) / 1000)) }),
    } satisfies HealthResponse);
  });

  // The socket authenticates with its first frame: browsers cannot set headers on a WebSocket.
  app.get(
    "/a/:assistant/connect",
    options.upgradeWebSocket((c) => {
      const nudge = options.assistants.get(c.req.param("assistant") ?? "");
      let connection: Connection | undefined;
      return {
        onOpen: (_event, ws) => {
          if (nudge === undefined) return ws.close(CLOSE.notFound, "No such assistant");
          connection = new Connection(
            {
              send: (text) => {
                if (ws.readyState === 1) ws.send(text);
              },
              close: (code, reason) => ws.close(code, reason),
            },
            {
              hubs: hubsOf(nudge),
              epoch,
              version: options.version,
              heartbeatMs: options.timing?.heartbeatMs ?? 25_000,
              flushMs: options.timing?.flushMs ?? 50,
              helloTimeoutMs: options.timing?.helloTimeoutMs ?? 10_000,
              report: (error) => options.report(error, { assistant: c.req.param("assistant") }),
            },
          );
        },
        onMessage: (event) => connection?.receive(String(event.data)),
        onClose: () => connection?.close(),
        onError: () => connection?.close(),
      };
    }),
  );

  // An extension's own socket for a room, such as the browser's live view.
  app.get(
    "/a/:assistant/rooms/:room/ext/:extension",
    options.upgradeWebSocket((c) => {
      const nudge = options.assistants.get(c.req.param("assistant") ?? "");
      const socket =
        nudge === undefined
          ? undefined
          : new ExtensionSocket(
              nudge,
              c.req.param("room") ?? "",
              c.req.param("extension") ?? "",
              (error) =>
                options.report(error, {
                  assistant: c.req.param("assistant"),
                  room: c.req.param("room"),
                  extension: c.req.param("extension"),
                }),
            );
      return {
        onOpen: (_event, ws) => {
          if (socket === undefined) ws.close(CLOSE.notFound, "No such assistant");
        },
        onMessage: (event, ws) => socket?.receive(String(event.data), ws),
        onClose: () => socket?.close(),
        onError: () => socket?.close(),
      };
    }),
  );

  if (options.server !== undefined)
    app.route(
      "/server",
      serverRoutes({
        control: options.server,
        version: options.version,
        publicUrl,
        trustProxy,
        modelErrors: options.modelErrors,
      }),
    );
  if (options.setup !== undefined) app.route("/setup", setupRoutes(options.setup));

  app.route(
    "/",
    restRoutes({
      assistants: options.assistants,
      hubsOf,
      publicUrl,
      trustProxy,
      extensionSettings: options.extensionSettings,
    }),
  );
  return app;
}
