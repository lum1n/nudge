import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { upgradeWebSocket as nodeUpgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Nudge } from "@nudge/core";
import { Hono, type MiddlewareHandler } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { HttpError } from "./v1/rest.ts";
import { type V1Options, v1Routes } from "./v1/routes.ts";

export type AppOptions = {
  /** By URL name: `/v1/a/<name>/…`. */
  readonly assistants: ReadonlyMap<string, Nudge>;
  /** A built web UI (a directory with `index.html`) to serve at every path outside `/v1`. */
  readonly web?: string;
  readonly onError?: (error: unknown) => void;
  /** The runtime's WebSocket upgrade; default Node's. */
  readonly upgradeWebSocket?: UpgradeWebSocket;
  /** Told to v1 clients in `welcome`. */
  readonly version?: string;
  readonly timing?: V1Options["timing"];
  /** The server's address as clients reach it, for pairing links; default each request's origin. */
  readonly publicUrl?: V1Options["publicUrl"];
  /** Whether to believe a proxy's `X-Forwarded-*` about the request's origin, as behind exe.dev's. */
  readonly trustProxy?: V1Options["trustProxy"];
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
  const report = options.onError ?? ((error) => console.error(error));

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    report(error);
    return c.json({ error: "Internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.route(
    "/v1",
    v1Routes({
      assistants: options.assistants,
      upgradeWebSocket: options.upgradeWebSocket ?? nodeUpgradeWebSocket,
      version: options.version ?? "0.0.0",
      report,
      timing: options.timing,
      publicUrl: options.publicUrl,
      trustProxy: options.trustProxy,
      extensionSettings: options.extensionSettings,
      server: options.server,
      setup: options.setup,
    }),
  );
  if (options.web !== undefined) serveWeb(app, options.web);
  return app;
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
