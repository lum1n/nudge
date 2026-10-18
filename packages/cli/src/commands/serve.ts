import { access, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Assistants,
  backupKey,
  buildModels,
  completeSetup,
  ConfigMissing,
  createBackup,
  detectLocalServers,
  loadConfig,
  newSetupCode,
  openAssistant,
  readRawConfig,
  RESTART_EXIT_CODE,
  ServerKeys,
  serverKeysDir,
  ServerOwners,
  serverOwnersFile,
  SetupCodes,
  Tailscale,
  routeTailnet,
  testProviderKey,
  Updates,
  writeRawConfig,
} from "@nudge/core";
import {
  type ServerControl,
  type SetupControl,
  serveNudge,
  type UpdateControl,
} from "@nudge/server";
import { renderUnicodeCompact } from "uqr";
import { UsageError } from "../errors.ts";
import { keyPath, scheduleBackups } from "./backup.ts";
import { offeredProviders } from "./setup-offer.ts";
import { hostOptions, reloadOnHangup } from "../host.ts";

export type ServeOptions = {
  readonly config: string;
  readonly port: number;
  readonly host: string;
  /** A built web UI; undefined for the bundled one, "none" for the API only. */
  readonly web?: string;
  /** The address apps reach the server at, for pairing links; default each request's. */
  readonly publicUrl?: string;
  /** Behind a proxy that ends TLS, such as exe.dev's: believe its `X-Forwarded-*` headers. */
  readonly trustProxy?: boolean;
};

/**
 * What a server in setup mode says: where the wizard is, with its one-time code in the link (the
 * part after `#` never reaches a server or its logs), and as a QR code for a phone.
 */
export function setupLines(
  url: string,
  host: string,
  code: string,
  web: string | undefined,
  interfaces = networkInterfaces(),
): string[] {
  const [first, ...others] = addressesOf(url, host, interfaces);
  const link = `${first ?? url}/setup#code=${code}`;
  const lines = [
    "Nudge isn't set up yet. Open this to set it up:",
    "",
    `  ${link}`,
    "",
    renderUnicodeCompact(link, { border: 2 }),
    `Or open /setup at ${[first, ...others].join(" or ")} and give the code ${code}.`,
  ];
  if (web === undefined)
    lines.push("There is no web UI here (pnpm build): set it up with the Nudge app instead.");
  if (host === "127.0.0.1" || host === "localhost" || host === "::1")
    lines.push("Only this computer can reach it. For a phone: nudge serve --host 0.0.0.0");
  return lines;
}

function addressesOf(url: string, host: string, interfaces: ReturnType<typeof networkInterfaces>) {
  const port = new URL(url).port;
  if (host !== "0.0.0.0" && host !== "::") return [url];
  const found = Object.values(interfaces)
    .flat()
    .filter((info) => info !== undefined && info.family === "IPv4" && !info.internal)
    .map((info) => `http://${info!.address}:${port}`);
  return found.length > 0 ? found : [url];
}

/** When setup closes: `NUDGE_SETUP_MINUTES` from now, or never. */
function setupDeadline(minutes: string | undefined): number {
  const value = Number(minutes);
  return minutes !== undefined && Number.isFinite(value) && value > 0
    ? Date.now() + value * 60_000
    : Number.POSITIVE_INFINITY;
}

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

/**
 * Runs every configured assistant behind one HTTP and WebSocket server until Ctrl-C. Without a
 * config it starts in setup mode (ADR 11): it prints a one-time code, and the wizard at `/setup`
 * sets the server up with it, after which the new assistant runs here without a restart.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const context = BACKGROUND_CONTEXT;
  const configPath = resolve(options.config);
  const say = (line: string) => console.log(line);
  let config = await loadConfig(configPath).catch((error: unknown) => {
    if (error instanceof ConfigMissing) return undefined;
    throw error;
  });
  const keys = new ServerKeys(serverKeysDir(configPath));
  const owners = new ServerOwners(serverOwnersFile(configPath));
  const assistants = await Assistants.open({
    configPath,
    open: (config, assistant) =>
      openAssistant(config, assistant, context, {
        ...hostOptions(assistant),
        models: buildModels(config.providers, keys.credentialsFor(assistant.name)),
      }),
    context,
    say,
    allowMissing: true,
  });
  let stopBackups = config === undefined ? () => {} : scheduleBackups(configPath, config, say);
  const testKey = (provider: string, key: string) =>
    testProviderKey(provider, key, config?.providers ?? []);
  const theBackupKey = () => backupKey(keyPath(configPath, config ?? { assistants: [] }), true);
  // Set when the server should stop and start again, as after installing a new release.
  let restart = () => {};
  let restarting = false;
  const updates = selfUpdates(
    () => config?.server?.updates !== "off",
    async (automatic) => {
      const raw = await readRawConfig(configPath);
      raw.server = { ...(raw.server as object | undefined), updates: automatic ? "auto" : "off" };
      await writeRawConfig(configPath, raw);
      config = await loadConfig(configPath);
    },
    () => {
      restarting = true;
      restart();
    },
    say,
  );
  const publicUrl = () => options.publicUrl ?? config?.server?.publicUrl;
  const tailscale = serverTailscale(configPath, publicUrl, say);
  try {
    // A new server's image can be older than the newest release, as when a platform keeps an
    // image it pulled before: it updates before setup, so it is set up on the newest one.
    if (config === undefined && (await updates?.installNewest())) return RESTART_EXIT_CODE;
    const web = await webRoot(options.web);
    const control: ServerControl = {
      assistants,
      keys,
      owners,
      backupBeforeDelete: async (only) => {
        const dir = join(dirname(configPath), "server", "deleted");
        const file = await createBackup({
          configPath,
          config: only,
          dir,
          key: await theBackupKey(),
        });
        await pruneOlder(dir, DELETED_KEPT_MS);
        return basename(file);
      },
      testKey,
      backupKey: theBackupKey,
      ...(updates === undefined ? {} : { updates: updates.control }),
      ...(tailscale === undefined ? {} : { tailscale }),
    };
    // A server made from the app gets its code, and how long it waits, in the environment.
    const code = process.env.NUDGE_SETUP_CODE || newSetupCode();
    const codes =
      config === undefined
        ? new SetupCodes(code, 10, setupDeadline(process.env.NUDGE_SETUP_MINUTES))
        : undefined;
    const setup: SetupControl | undefined =
      codes === undefined
        ? undefined
        : {
            codes,
            offer: async () => ({
              providers: offeredProviders(),
              local: await detectLocalServers(),
            }),
            testKey,
            complete: async (choices, client) => {
              const result = await completeSetup(
                { configPath, assistants, keys, owners },
                choices,
                client,
                context,
              );
              config = await loadConfig(configPath);
              stopBackups = scheduleBackups(configPath, config, say);
              say(`Set up: ${result.assistant}, with ${result.player.displayName} as its owner.`);
              return result;
            },
          };
    const server = await serveNudge({
      assistants: assistants.running,
      version: process.env.NUDGE_VERSION ?? "0.0.0",
      port: options.port,
      hostname: options.host,
      web,
      publicUrl,
      trustProxy: () => options.trustProxy === true || config?.server?.trustProxy === true,
      server: control,
      ...(setup === undefined ? {} : { setup }),
      extensionSettings: {
        list: (assistant) => assistants.extensionSetups(assistant),
        save: (assistant, extensions) => assistants.saveExtensionSetups(assistant, extensions),
      },
    });
    const lines =
      codes === undefined
        ? startupLines(server.url, options.host, [...assistants.running.keys()], web)
        : setupLines(server.url, options.host, code, web);
    for (const line of lines) console.log(line);
    const stopReloading = reloadOnHangup(assistants, say);
    const stopUpdates = updates?.start() ?? (() => {});
    await new Promise<void>((resolve) => {
      restart = resolve;
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    stopReloading();
    stopUpdates();
    stopBackups();
    tailscale?.stop();
    console.log(restarting ? "Restarting into the new release…" : "Stopping…");
    await server.close();
  } finally {
    await assistants.close();
  }
  return restarting ? RESTART_EXIT_CODE : 0;
}

/**
 * The server's own Tailscale, on Linux, where Tailscale's static builds run: started again if an
 * owner connected it before, and carrying this process's requests to tailnet addresses. It is
 * named for the server's address, such as `nudge-robin` for `https://robin.exe.xyz`.
 */
function serverTailscale(
  configPath: string,
  publicUrl: () => string | undefined,
  say: (line: string) => void,
): Tailscale | undefined {
  if (process.platform !== "linux") return undefined;
  const tailscale = new Tailscale({
    dir: join(dirname(configPath), "server", "tailscale"),
    // A release has Node in node/bin and Tailscale in tailscale/.
    bundled: join(dirname(process.execPath), "..", "..", "tailscale"),
    hostname: () => {
      const label = /^https?:\/\/([a-z0-9-]+)/i.exec(publicUrl() ?? "")?.[1];
      return label === undefined ? "nudge" : `nudge-${label.toLowerCase()}`;
    },
    say,
  });
  routeTailnet(() => tailscale.proxy);
  void tailscale.resume();
  return tailscale;
}

/**
 * Self-update (ADR 11) when `nudge-server` started this server, which says so with
 * `NUDGE_RELEASES` and `NUDGE_VERSION`: a check 10 minutes after starting (or
 * `NUDGE_UPDATE_DELAY` seconds) and every day after, installing what it finds while `automatic`
 * says so. After 30 s of running, this release confirms itself, so a rollback no longer happens.
 */
function selfUpdates(
  automatic: () => boolean,
  setAutomatic: (automatic: boolean) => Promise<void>,
  restart: () => void,
  say: (line: string) => void,
):
  | {
      control: UpdateControl;
      start(): () => void;
      /** Installs a newer release now, if there is one; true when the server should restart into it. */
      installNewest(): Promise<boolean>;
    }
  | undefined {
  const releasesDir = process.env.NUDGE_RELEASES;
  const current = process.env.NUDGE_VERSION;
  if (releasesDir === undefined || current === undefined) return undefined;
  const updates = new Updates({
    releasesDir,
    current,
    platform: `linux-${process.arch}`,
    ...(process.env.NUDGE_UPDATES_URL ? { manifestUrl: process.env.NUDGE_UPDATES_URL } : {}),
    // Another signer's releases, such as a fork's or a test's; anyone who sets this runs the server.
    ...(process.env.NUDGE_RELEASE_KEYS ? { keys: process.env.NUDGE_RELEASE_KEYS.split(",") } : {}),
  });
  let installing = false;
  const check = async () => {
    const release = await updates.check();
    if (release !== undefined && automatic() && !installing) {
      installing = true;
      try {
        say(`Installing Nudge ${release.version}…`);
        await updates.install(release);
        restart();
      } catch (error) {
        say(`Could not install ${release.version}: ${(error as Error).message}`);
        installing = false;
      }
    }
    return updates.state(automatic());
  };
  return {
    control: {
      state: () => updates.state(automatic()),
      check,
      setAutomatic: async (on) => {
        await setAutomatic(on);
        return updates.state(automatic());
      },
    },
    installNewest: async () => {
      const release = await updates.check();
      if (release === undefined) return false;
      try {
        say(`Installing Nudge ${release.version} before setup…`);
        await updates.install(release);
        return true;
      } catch (error) {
        say(`Could not install ${release.version}: ${(error as Error).message}`);
        return false;
      }
    },
    start: () => {
      const delay = Number(process.env.NUDGE_UPDATE_DELAY ?? 600) * 1000;
      const confirm = setTimeout(
        () => void updates.confirm().catch((error: Error) => say(error.message)),
        30_000,
      );
      let daily: ReturnType<typeof setInterval> | undefined;
      const first = setTimeout(() => {
        void check();
        daily = setInterval(() => void check(), 24 * 60 * 60_000);
      }, delay);
      return () => {
        clearTimeout(confirm);
        clearTimeout(first);
        clearInterval(daily);
      };
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

/** How long the backup of a deleted assistant is kept, in case it was deleted by mistake. */
const DELETED_KEPT_MS = 30 * 24 * 60 * 60_000;

async function pruneOlder(dir: string, age: number): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const file = join(dir, name);
    const info = await stat(file).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs > age) await rm(file, { force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
