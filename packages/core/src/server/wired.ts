import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Agent, type Dispatcher } from "undici";

/**
 * Wired (github.com/lum1n/wired): an encrypted network between Nudge servers that needs no open
 * port on a home server. The home server is the network's root and only dials out. Servers with
 * a public HTTPS address, such as exe.dev's, serve a relay behind it, through which every server
 * reaches every other. A server's API is reached at `http://nudge.<name>.wired`.
 */

/** What the server API shows of the server's Wired. */
export type WiredState = {
  /**
   * `off`: not asked for; `unavailable`: this release has no Wired; `starting`; `root`: this
   * server holds the network; `member`: it joined one; `error`: see `error`.
   */
  readonly state: "off" | "unavailable" | "starting" | "root" | "member" | "error";
  /** Its name in the network: other servers reach it at `http://nudge.<name>.wired`. */
  readonly name?: string;
  readonly members?: { name: string; anchor: boolean }[];
  readonly relays?: string[];
  /** The relay this server serves, at its public address. */
  readonly relay?: string;
  readonly error?: string;
};

export class WiredError extends Error {
  override name = "WiredError";
}

/** Whether `hostname` is reached over Wired: `<service>.<node>.wired`. */
export function isWiredHost(hostname: string): boolean {
  return /^[a-z0-9-]+\.[a-z0-9-]+\.wired\.?$/i.test(hostname);
}

/** `nudge.robin.wired` → `nudge@robin`. */
export function wiredTarget(hostname: string): string {
  const [service, node] = hostname.toLowerCase().split(".");
  return `${service}@${node}`;
}

/** A name Wired accepts (`[a-z0-9-]`, 1–63), from a label such as a host name. */
export function wiredName(label: string): string {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return name === "" ? "nudge" : name;
}

/** The parts of `@wired/node` this uses. */
export type WiredNode = {
  readonly name: string;
  readonly invite: string;
  readonly isRoot: boolean;
  members(): { name: string; anchor: boolean }[];
  relays(): { url: string }[];
  readonly servedRelay: { url: string; localAddr: string } | null;
  addRelay(url: string): void;
  dial(target: string): Promise<Duplex>;
  expose(service: string, target: string): { close(): void };
  close(): Promise<void>;
};

export type RelayFront = {
  matches(req: { url?: string }): boolean;
  request(req: unknown, res: unknown): void;
  upgrade(req: unknown, socket: unknown, head: unknown): void;
};

export type WiredModule = {
  Node: {
    anchor(options: Record<string, unknown>): Promise<WiredNode>;
    join(options: Record<string, unknown>): Promise<WiredNode>;
  };
  relayProxy(localAddr: string): RelayFront;
};

export type WiredOptions = {
  /** Where its keys and state go: `server/wired` beside the config. */
  readonly dir: string;
  /** The server's public address, such as `https://robin.exe.xyz`; a relay is served there. */
  readonly publicUrl: () => string | undefined;
  /** Where a relay listens behind the public address; default 127.0.0.1:8790. */
  readonly relayBind?: string;
  /** Loads `@wired/node`; undefined when this release has none. */
  readonly load?: () => Promise<WiredModule | undefined>;
  readonly say?: (line: string) => void;
};

/**
 * Loads `@wired/node` from `NUDGE_WIRED_MODULE` (a path), or as an installed package. Wired is
 * optional: a release without it serves as before.
 */
export async function loadWired(): Promise<WiredModule | undefined> {
  const from = process.env.NUDGE_WIRED_MODULE;
  try {
    const module = (await import(from !== undefined && from !== "" ? from : "@wired/node")) as {
      default?: WiredModule;
    } & Partial<WiredModule>;
    const wired = (module.default ?? module) as WiredModule;
    return typeof wired.Node?.anchor === "function" ? wired : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server's own Wired (see the top of this file). A home server becomes the network's root
 * when an owner turns it on. A server made from the app joins with the invite it was given in
 * `NUDGE_WIRED_INVITE`, and serves a relay at its public HTTPS address: `NUDGE_WIRED_RELAY_URL`,
 * or else its public URL. Once on, it stays so across restarts.
 */
export class ServerWired {
  private module: WiredModule | undefined;
  private loaded = false;
  /** Where this server's relay is reached, as its launcher said (`NUDGE_WIRED_RELAY_URL`). */
  private givenRelayUrl: string | undefined;
  private node: WiredNode | undefined;
  private agent: Agent | undefined;
  private exposed: { close(): void } | undefined;
  private starting: Promise<void> | undefined;
  private error: string | undefined;
  private readonly say: (line: string) => void;

  constructor(private readonly options: WiredOptions) {
    this.say = options.say ?? (() => {});
  }

  private get roleFile(): string {
    return join(this.options.dir, "role");
  }

  private get inviteFile(): string {
    return join(this.options.dir, "invite");
  }

  private get relayUrlFile(): string {
    return join(this.options.dir, "relay-url");
  }

  private get relayBind(): string {
    return this.options.relayBind ?? "127.0.0.1:8790";
  }

  /** `@wired/node`, if this release has it. Call before `relayFront`. */
  async load(): Promise<boolean> {
    if (!this.loaded) {
      this.module = await (this.options.load ?? loadWired)();
      this.givenRelayUrl =
        process.env.NUDGE_WIRED_RELAY_URL ||
        (await readFile(this.relayUrlFile, "utf8").then((s) => s.trim(), () => undefined));
      this.loaded = true;
    }
    return this.module !== undefined;
  }

  /**
   * The public HTTPS address a relay is served at, when this server has one: what its launcher
   * said, which works before setup gives the server a public address, or else that address.
   */
  private relayUrl(): string | undefined {
    const url = this.givenRelayUrl || this.options.publicUrl();
    if (url === undefined) return undefined;
    const parsed = new URL(url);
    // Plain HTTP only on this computer, for tests and trying it out.
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    return parsed.protocol === "https:" || local ? parsed.origin : undefined;
  }

  /**
   * Forwards `/relay` and `/ping` on the server's own port to its relay, when it serves one:
   * on a platform with one HTTPS port, such as exe.dev, the relay shares it.
   */
  relayFront(): RelayFront | undefined {
    if (this.module === undefined || this.relayUrl() === undefined) return undefined;
    if (!existsSync(this.roleFile) && !process.env.NUDGE_WIRED_INVITE) return undefined;
    return this.module.relayProxy(this.relayBind);
  }

  /**
   * Starts again as before, or joins with `NUDGE_WIRED_INVITE` the first time. `apiAddr` is
   * where this server's own API listens, which the network reaches as `nudge.<name>.wired`.
   */
  async resume(name: string, apiAddr: string): Promise<void> {
    if (!(await this.load())) return;
    const invite = process.env.NUDGE_WIRED_INVITE;
    if (!existsSync(this.roleFile) && invite) {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      await writeFile(this.inviteFile, invite, { mode: 0o600 });
      if (this.givenRelayUrl) await writeFile(this.relayUrlFile, `${this.givenRelayUrl}\n`);
      await writeFile(this.roleFile, "member\n");
    }
    if (!existsSync(this.roleFile)) return;
    await this.start(name, apiAddr).catch(() => {});
  }

  /** Makes this server the network's root. */
  async enableRoot(name: string, apiAddr: string): Promise<WiredState> {
    if (!(await this.load())) return this.state();
    if (this.node !== undefined) return this.state();
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.roleFile, "root\n");
    await this.start(name, apiAddr).catch(() => {});
    return this.state();
  }

  /**
   * On the root: lists a relay a new server will serve at `url`, so the network can reach it
   * before it joins, and answers with the invite to give it.
   */
  async addRelay(url: string): Promise<string> {
    await this.starting;
    const node = this.node;
    if (node === undefined || !node.isRoot)
      throw new WiredError("Only the server that holds the network can add relays");
    node.addRelay(new URL(url).origin);
    return node.invite;
  }

  private start(name: string, apiAddr: string): Promise<void> {
    this.starting ??= this.run(name, apiAddr).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async run(name: string, apiAddr: string): Promise<void> {
    const module = this.module;
    if (module === undefined) return;
    this.error = undefined;
    try {
      const role = (await readFile(this.roleFile, "utf8")).trim();
      const stateDir = join(this.options.dir, "state");
      const relayUrl = this.relayUrl();
      const relay = relayUrl === undefined ? {} : { relayUrl, relayBind: this.relayBind };
      this.node =
        role === "root"
          ? await module.Node.anchor({ name, stateDir, port: 0, noRelay: relayUrl === undefined, ...relay })
          : await module.Node.join({
              name,
              stateDir,
              invite: (await readFile(this.inviteFile, "utf8")).trim(),
              ...relay,
            });
      const node = this.node;
      this.agent = new Agent({
        connect: (options, callback) => {
          node.dial(wiredTarget(options.hostname)).then(
            (socket) => callback(null, socket as never),
            (error: Error) => callback(error, null),
          );
        },
      });
      this.exposed = node.expose("nudge", apiAddr);
      this.say(`Wired: ${role === "root" ? "holding" : "joined"} the network as ${name}`);
    } catch (error) {
      this.error = (error as Error).message;
      this.say(`Wired didn't start: ${this.error}`);
      throw error;
    }
  }

  state(): WiredState {
    if (this.loaded && this.module === undefined) return { state: "unavailable" };
    if (this.starting !== undefined) return { state: "starting" };
    if (this.error !== undefined) return { state: "error", error: this.error };
    const node = this.node;
    if (node === undefined) return { state: "off" };
    const served = node.servedRelay;
    return {
      state: node.isRoot ? "root" : "member",
      name: node.name,
      members: node.members().map(({ name, anchor }) => ({ name, anchor })),
      relays: node.relays().map((r) => r.url),
      ...(served === null ? {} : { relay: served.url }),
    };
  }

  /** Carries requests to `*.wired` hosts over the network; see `routeOutgoing`. */
  dispatcher(): Dispatcher | undefined {
    return this.node === undefined ? undefined : this.agent;
  }

  /** Leaves the network for now; it is joined again on the next start. */
  async stop(): Promise<void> {
    this.exposed?.close();
    await this.agent?.close();
    await this.node?.close();
    this.node = undefined;
    this.agent = undefined;
  }

  /** Leaves for good: forgets the role, keys and invite. */
  async forget(): Promise<void> {
    await this.stop();
    await rm(this.options.dir, { recursive: true, force: true });
  }
}

/** The name a server goes by in the network: its public address's first label, or the host's. */
export function serverWiredName(publicUrl: string | undefined): string {
  const label = /^https?:\/\/([a-z0-9-]+)/i.exec(publicUrl ?? "")?.[1];
  return wiredName(label ?? hostname().split(".")[0] ?? "nudge");
}
