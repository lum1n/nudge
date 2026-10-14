import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildModels, loadConfig, type Nudge, openAssistant } from "@nudge/core";
import { generateVapidKeys, serveNudge, type VapidKeys } from "@nudge/server";
import { UsageError } from "../errors.ts";
import { hostOptions, reloadOnHangup } from "../host.ts";

export type ServeOptions = {
  readonly config: string;
  readonly port: number;
  readonly host: string;
  /** A built web UI; undefined for the bundled one, "none" for the API only. */
  readonly web?: string;
  /** The address apps reach the server at, for pairing links; default each request's. */
  readonly publicUrl?: string;
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
    const database = config.assistants[0]?.database;
    const server = await serveNudge({
      assistants,
      port: options.port,
      hostname: options.host,
      web,
      publicUrl: options.publicUrl,
      ...(database === undefined || database === ":memory:"
        ? {}
        : {
            push: {
              vapid: await vapidKeys(join(dirname(database), "push-vapid.json")),
              subject: pushSubject(config.push?.subject, options.publicUrl),
              preview: config.push?.preview === "text",
            },
          }),
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

/** The server's VAPID keys, made on first start; browsers' subscriptions are bound to them. */
async function vapidKeys(file: string): Promise<VapidKeys> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as VapidKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keys = generateVapidKeys();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(keys, null, 2), { mode: 0o600, flag: "wx" });
  return keys;
}

/**
 * Who push services can reach about this server: `push.subject` in the config, else an HTTPS
 * public URL. Apple refuses local addresses, so never `localhost`.
 */
function pushSubject(subject: string | undefined, publicUrl: string | undefined): string {
  if (subject !== undefined) return subject;
  if (publicUrl?.startsWith("https://")) return publicUrl;
  return "https://github.com/lum1n/nudge";
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
