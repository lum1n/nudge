import { randomBytes } from "node:crypto";
import type { Nudge } from "@nudge/core";
import { CLOSE } from "@nudge/protocol";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { Connection, type ConnectionOptions } from "./connection.ts";
import { ExtensionSocket } from "./extension-socket.ts";
import { Hubs } from "./hub.ts";
import { type ExtensionSettings, restRoutes } from "./rest.ts";
import { Pushes, type PushesOptions } from "../push/pushes.ts";

export type V1Options = {
  readonly assistants: ReadonlyMap<string, Nudge>;
  readonly upgradeWebSocket: UpgradeWebSocket;
  readonly version: string;
  readonly report: (error: unknown) => void;
  /** The server's address as clients reach it, for pairing links; default each request's origin. */
  readonly publicUrl?: string;
  /** Web Push for every assistant; none without. */
  readonly push?: PushesOptions;
  /** Setting up extensions from the web UI; none without. */
  readonly extensionSettings?: ExtensionSettings;
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
  const hubs = new Map<Nudge, Hubs>();
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

  // Made now, not on first use: pushes go out while nobody is connected.
  const pushes = new Map<Nudge, Pushes>();
  if (options.push !== undefined)
    for (const [name, nudge] of options.assistants)
      pushes.set(nudge, new Pushes(nudge, name, options.push, options.report));

  app.route(
    "/",
    restRoutes({
      assistants: options.assistants,
      hubsOf,
      pushesOf: (nudge) => pushes.get(nudge),
      publicUrl: options.publicUrl,
      extensionSettings: options.extensionSettings,
    }),
  );
  return app;
}
