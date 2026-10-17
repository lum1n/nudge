import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  buildModels,
  ConfigError,
  listExtensionSetups,
  loadConfig,
  loadExtensions,
  type Nudge,
  openAssistant,
  saveExtensionSetups,
} from "@nudge/core";
import { type ExtensionSettings, serveNudge } from "@nudge/server";
import { UsageError } from "../errors.ts";
import { scheduleBackups } from "./backup.ts";
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

/**
 * Where to reach the server: on this computer only, or at each of its network addresses when it
 * listens on all of them, as apps on a phone need.
 */
export function startupLines(
  url: string,
  host: string,
  assistants: readonly string[],
  web: string | undefined,
  interfaces = networkInterfaces(),
): string[] {
  const port = new URL(url).port;
  const everywhere = host === "0.0.0.0" || host === "::";
  const addresses = everywhere
    ? Object.values(interfaces)
        .flat()
        .filter((info) => info !== undefined && info.family === "IPv4" && !info.internal)
        .map((info) => `http://${info!.address}:${port}`)
    : [url];
  const lines = [
    `Nudge is serving ${assistants.join(", ")} at ${addresses.join(", ") || url}` +
      (web === undefined ? " (API only)" : ", with the web UI"),
  ];
  if (everywhere)
    lines.push(
      "Plain HTTP: anyone on this network can read what goes over it, tokens included. Put a TLS proxy in front, or use a VPN such as Tailscale, beyond a network you trust.",
    );
  else if (host === "127.0.0.1" || host === "localhost" || host === "::1")
    lines.push(
      "Only this computer can reach it. For phones and other computers: nudge serve --host 0.0.0.0",
    );
  lines.push(
    "Sign in apps with a code from: nudge pair <player>   Chat here: NUDGE_TOKEN=… nudge chat --url <address>",
  );
  return lines;
}

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
      publicUrl: options.publicUrl,
      extensionSettings: configExtensions(options.config, assistants, (line) => console.log(line)),
    });
    for (const line of startupLines(server.url, options.host, [...assistants.keys()], web))
      console.log(line);
    const stopReloading = reloadOnHangup(options.config, assistants);
    const stopBackups = scheduleBackups(options.config, config, (line) => console.log(line));
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    stopReloading();
    stopBackups();
    console.log("Stopping…");
    await server.close();
  } finally {
    for (const nudge of assistants.values()) await nudge.close(context);
  }
}

/**
 * The web UI's settings page, over the config file: saving reinstalls the assistant's extensions
 * as `nudge reload` does, and writes the file once that worked. Saves run one at a time.
 */
function configExtensions(
  configPath: string,
  assistants: ReadonlyMap<string, Nudge>,
  say: (line: string) => void,
): ExtensionSettings {
  let saving = Promise.resolve();
  return {
    list: (assistant) => listExtensionSetups(configPath, assistant),
    save: (assistant, extensions) => {
      const save = saving.then(async () => {
        await saveExtensionSetups(configPath, assistant, extensions, async (config) => {
          const nudge = assistants.get(assistant);
          const entry = config.assistants.find((a) => a.name === assistant);
          if (nudge === undefined || entry === undefined) return;
          let installed;
          try {
            installed = await nudge.reloadExtensions(
              await loadExtensions(entry.extensions ?? [], { fresh: true }),
            );
          } catch (error) {
            // An extension that won't start, such as one missing its token, is the admin's to fix.
            throw error instanceof ConfigError
              ? error
              : new ConfigError(`Nothing changed: ${(error as Error).message}`);
          }
          const names = installed.map((e) => `${e.name}${e.version ? ` ${e.version}` : ""}`);
          say(`${assistant}: extensions set up from the web: ${names.join(", ") || "none"}`);
        });
        return listExtensionSetups(configPath, assistant);
      });
      saving = save.then(
        () => {},
        () => {},
      );
      return save;
    },
  };
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
