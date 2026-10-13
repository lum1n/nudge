import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildModels, loadConfig, type Nudge, openAssistant } from "@nudge/core";
import { serveNudge } from "@nudge/server";
import { UsageError } from "../errors.ts";
import { hostOptions, reloadOnHangup } from "../host.ts";

export type ServeOptions = {
  readonly config: string;
  readonly port: number;
  readonly host: string;
  /** A built web UI; undefined for the bundled one, "none" for the API only. */
  readonly web?: string;
};

/** Runs every configured assistant behind one HTTP and WebSocket server until Ctrl-C. */
export async function serve(options: ServeOptions): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  const config = await loadConfig(options.config);
  const models = buildModels(config.providers);
  const assistants = new Map<string, Nudge>();
  try {
    for (const assistant of config.assistants) {
      const nudge = await openAssistant(config, assistant, context, {
        ...hostOptions(assistant),
        models,
      });
      assistants.set(assistant.name, nudge);
    }
    const web = await webRoot(options.web);
    const server = await serveNudge({
      assistants,
      port: options.port,
      hostname: options.host,
      web,
    });
    if (web !== undefined) console.log(`Web: ${server.url}`);
    for (const name of assistants.keys()) console.log(`${name}: ${server.url}/a/${name}`);
    console.log("Connect with: NUDGE_TOKEN=… nudge chat --url <url above>");
    const stopReloading = reloadOnHangup(options.config, assistants);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    stopReloading();
    console.log("Stopping…");
    await server.close();
  } finally {
    for (const nudge of assistants.values()) await nudge.close(context);
  }
}

async function webRoot(option: string | undefined): Promise<string | undefined> {
  if (option === "none") return undefined;
  if (option !== undefined) {
    const root = resolve(option);
    if (!(await exists(join(root, "index.html"))))
      throw new UsageError(`--web ${option} has no index.html: build the web UI first`);
    return root;
  }
  try {
    const bundled = join(
      dirname(createRequire(import.meta.url).resolve("@nudge/web/package.json")),
      "dist",
    );
    if (await exists(join(bundled, "index.html"))) return bundled;
  } catch {
    // Not installed.
  }
  console.log("No web UI built (pnpm build); serving the API only.");
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
