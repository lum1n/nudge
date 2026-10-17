import { randomBytes } from "node:crypto";
import type { Nudge } from "@nudge/core";
import { CLOSE } from "@nudge/protocol";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { Connection, type ConnectionOptions } from "./connection.ts";
import { ExtensionSocket } from "./extension-socket.ts";
import { Hubs } from "./hub.ts";
import { type ExtensionSettings, restRoutes } from "./rest.ts";
import { type ServerControl, serverRoutes } from "./server.ts";
import { type SetupControl, setupRoutes } from "./setup.ts";

export type V1Options = {
  readonly assistants: ReadonlyMap<string, Nudge>;
  readonly upgradeWebSocket: UpgradeWebSocket;
  readonly version: string;
  readonly report: (error: unknown) => void;
  /**
   * The server's address as clients reach it, for pairing links; default each request's origin.
   * Read on every request, since setup may set it.
   */
  readonly publicUrl?: string | (() => string | undefined);
  /** Whether to believe a proxy's `X-Forwarded-*` about the request's origin. */
  readonly trustProxy?: boolean | (() => boolean);
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
  // A new epoch per app, so clients that reconnect after a restart know to subscribe again.
  const epoch = randomBytes(8).toString("base64url");
  const hubs = new WeakMap<Nudge, Hubs>();
  const hubsOf = (nudge: Nudge) => {
    let found = hubs.get(nudge);
    if (found === undefined) hubs.set(nudge, (found = new Hubs(nudge, options.report)));
    return found;
  };

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
              report: options.report,
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
              options.report,
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

  const { publicUrl: url, trustProxy: trust } = options;
  const publicUrl = typeof url === "function" ? url : () => url;
  const trustProxy = typeof trust === "function" ? trust : () => trust === true;
  if (options.server !== undefined)
    app.route(
      "/server",
      serverRoutes({ control: options.server, version: options.version, publicUrl, trustProxy }),
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
