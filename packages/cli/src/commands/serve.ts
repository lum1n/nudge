import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  buildModels,
  ConfigError,
  listExtensionSetups,
  loadConfig,
  loadExtensions,
  type Nudge,
  type NudgeConfig,
  openAssistant,
  saveExtensionSetups,
} from "@nudge/core";
import {
  type ExtensionSettings,
  generateVapidKeys,
  type PushesOptions,
  serveNudge,
  type ServiceAccount,
  type VapidKeys,
} from "@nudge/server";
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
      extensionSettings: configExtensions(options.config, assistants, (line) => console.log(line)),
      ...(database === undefined || database === ":memory:"
        ? {}
        : {
            push: {
              vapid: await vapidKeys(join(dirname(database), "push-vapid.json")),
              subject: pushSubject(config.push?.subject, options.publicUrl),
              preview: config.push?.preview === "text",
              ...(await nativePush(options.config, config.push)),
            },
          }),
    });
    if (web !== undefined) console.log(`Web: ${server.url}`);
    for (const name of assistants.keys()) console.log(`${name}: ${server.url}/a/${name}`);
    console.log("Connect with: NUDGE_TOKEN=… nudge chat --url <url above>");
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

/** APNs and FCM credentials named in the config, read from their files. */
async function nativePush(
  configPath: string,
  push: NudgeConfig["push"],
): Promise<Pick<PushesOptions, "apns" | "fcm">> {
  const read = async (file: string, what: string) => {
    try {
      return await readFile(resolve(dirname(configPath), file), "utf8");
    } catch (error) {
      throw new ConfigError(`push.${what}: can't read ${file}: ${(error as Error).message}`);
    }
  };
  const apns = push?.apns;
  const fcm = push?.fcm;
  let serviceAccount: ServiceAccount | undefined;
  if (fcm !== undefined) {
    try {
      serviceAccount = JSON.parse(await read(fcm.serviceAccountFile, "fcm.serviceAccountFile"));
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`push.fcm.serviceAccountFile is not JSON`);
    }
  }
  return {
    ...(apns === undefined
      ? {}
      : {
          apns: {
            key: await read(apns.keyFile, "apns.keyFile"),
            keyId: apns.keyId,
            teamId: apns.teamId,
            bundleId: apns.bundleId ?? "app.nudge.dev",
          },
        }),
    ...(serviceAccount === undefined ? {} : { fcm: { serviceAccount } }),
  };
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
