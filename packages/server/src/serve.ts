import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { RelayFront } from "@nudge/core";
import { WebSocketServer } from "ws";
import { type AppOptions, createApp } from "./app.ts";

export type ServeOptions = AppOptions & {
  /** Default 8787; 0 picks a free port. */
  readonly port?: number;
  /** Default 127.0.0.1: put a TLS proxy in front before exposing it. */
  readonly hostname?: string;
  /**
   * The server's Wired relay, when it serves one behind the same port (as on exe.dev): requests
   * and upgrades it `matches` (`/relay`, `/ping`) go to it, never to the app.
   */
  readonly relay?: RelayFront;
};

export type RunningServer = {
  /** `http://<host>:<port>` */
  readonly url: string;
  /** Stops accepting connections and drops open streams. The assistants stay open. */
  close(): Promise<void>;
};

export function serveNudge(options: ServeOptions): Promise<RunningServer> {
  const app = createApp(options);
  const wss = new WebSocketServer({ noServer: true });
  const hostname = options.hostname ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    const relay = options.relay;
    const server = serve(
      {
        fetch: app.fetch,
        port: options.port ?? 8787,
        hostname,
        websocket: { server: wss },
        ...(relay === undefined
          ? {}
          : {
              createServer: ((serverOptions: object, listener: (req: IncomingMessage, res: never) => void) => {
                const http = createServer(serverOptions, (req, res) =>
                  relay.matches(req) ? relay.request(req, res) : listener(req, res as never),
                );
                // Upgrades are emitted to every listener, the app's included: keep the relay's
                // from reaching it.
                const emit = http.emit.bind(http);
                http.emit = ((event: string, ...args: unknown[]) => {
                  if (event === "upgrade" && relay.matches(args[0] as IncomingMessage)) {
                    relay.upgrade(args[0], args[1], args[2]);
                    return true;
                  }
                  return emit(event, ...args);
                }) as typeof http.emit;
                return http;
              }) as never,
            }),
      },
      (info: AddressInfo) => {
        const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
        resolve({
          url: `http://${host}:${info.port}`,
          close: () =>
            new Promise<void>((done) => {
              for (const client of wss.clients) client.terminate();
              wss.close();
              server.close(() => done());
              (server as { closeAllConnections?: () => void }).closeAllConnections?.();
            }),
        });
      },
    );
    server.once("error", reject);
  });
}
