import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { type AppOptions, createApp } from "./app.ts";

export type ServeOptions = AppOptions & {
  /** Default 8787; 0 picks a free port. */
  readonly port?: number;
  /** Default 127.0.0.1: put a TLS proxy in front before exposing it. */
  readonly hostname?: string;
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
    const server = serve(
      { fetch: app.fetch, port: options.port ?? 8787, hostname, websocket: { server: wss } },
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
