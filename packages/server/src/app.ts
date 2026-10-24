import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { upgradeWebSocket as nodeUpgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { errorFields, type LogFields, type Logger, loggerFromEnv, type Nudge } from "@nudge/core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { HttpError } from "./v1/rest.ts";
import { type V1Options, v1Routes } from "./v1/routes.ts";

export type AppOptions = {
  /** By URL name: `/v1/a/<name>/…`. */
  readonly assistants: ReadonlyMap<string, Nudge>;
  /** A built web UI (a directory with `index.html`) to serve at every path outside `/v1`. */
  readonly web?: string;
  /** Told of every unexpected error instead of `logger`, with the route and assistant it was for. */
  readonly onError?: (error: unknown, fields: LogFields) => void;
  /** Where errors go; default one as `NUDGE_LOG_LEVEL` and `NUDGE_LOG_FORMAT` ask, on stderr. */
  readonly logger?: Logger;
  /** The host's last model errors, for `GET /v1/health` and owners at `GET /v1/server`. */
  readonly modelErrors?: V1Options["modelErrors"];
  /** The runtime's WebSocket upgrade; default Node's. */
  readonly upgradeWebSocket?: UpgradeWebSocket;
  /** Told to v1 clients in `welcome`. */
  readonly version?: string;
  readonly timing?: V1Options["timing"];
  /** The server's address as clients reach it, for pairing links; default each request's origin. */
  readonly publicUrl?: V1Options["publicUrl"];
  /** Whether to believe a proxy's `X-Forwarded-*` about the request's origin, as behind exe.dev's. */
  readonly trustProxy?: V1Options["trustProxy"];
  /** Requests allowed per address and per token; default generous, and strict for codes. */
  readonly limits?: V1Options["limits"];
  /** The address a request came from, for rate limits; default the Node socket's. */
  readonly peerAddress?: V1Options["peerAddress"];
  /** Setting up extensions from the web UI, such as in the config file; none without. */
  readonly extensionSettings?: V1Options["extensionSettings"];
  /** The server's own API for its owners (ADR 11); none without. */
  readonly server?: V1Options["server"];
  /** Setup mode, for a server with no config yet (ADR 11); none without. */
  readonly setup?: V1Options["setup"];
};

/** Nudge's HTTP and WebSocket API (protocol v1, under `/v1`) over one or more assistants. */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const log = options.logger ?? loggerFromEnv(process.env, process.stderr.isTTY === true);
  const report =
    options.onError ??
    ((error: unknown, fields: LogFields) =>
      log.error(fields.route === undefined ? "Background error" : "Request failed", {
        ...fields,
        ...errorFields(error),
      }));

  app.onError((error, c) => {
    if (error instanceof HttpError) return error.respond(c);
    // The route's pattern, not its path, and only the ids that say whose it was: no tokens.
    const params = c.req.param() as Record<string, string | undefined>;
    report(error, {
      method: c.req.method,
      route: c.req.routePath,
      assistant: params.assistant,
      room: params.room,
    });
    return c.json({ error: "Internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.route(
    "/v1",
    v1Routes({
      assistants: options.assistants,
      upgradeWebSocket: options.upgradeWebSocket ?? nodeUpgradeWebSocket,
      version: options.version ?? "0.0.0",
      report: (error, fields) => report(error, fields ?? {}),
      modelErrors: options.modelErrors,
      timing: options.timing,
      publicUrl: options.publicUrl,
      trustProxy: options.trustProxy,
      limits: options.limits,
      peerAddress: options.peerAddress ?? nodePeerAddress,
      extensionSettings: options.extensionSettings,
      server: options.server,
      setup: options.setup,
    }),
  );
  if (options.web !== undefined) serveWeb(app, options.web);
  return app;
}

/** The socket's remote address under `@hono/node-server`; undefined elsewhere, as in tests. */
function nodePeerAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

/** Files from the build, and `index.html` for every other page so the browser's router takes over. */
function serveWeb(app: Hono, root: string): void {
  const outsideApi: MiddlewareHandler = async (c, next) => {
    const path = c.req.path;
    if (path === "/v1" || path.startsWith("/v1/")) return c.notFound();
    await next();
  };
  app.get("*", outsideApi, serveStatic({ root }), async (c) => {
    const page = await readFile(join(root, "index.html"), "utf8").catch(() => undefined);
    return page === undefined ? c.notFound() : c.html(page);
  });
}
