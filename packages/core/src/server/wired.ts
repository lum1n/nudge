import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { Agent, Dispatcher, setGlobalDispatcher } from "undici";

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
  /**
   * Its name in the network: other servers reach it at `http://nudge.<name>.wired`. While off,
   * the name it takes when turned on or joining, unless the owner picks another.
   */
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

/** Whether `name` is one Wired accepts as it is: `box`, not `Box` or `-box`. */
export function isWiredName(name: string): boolean {
  return name !== "" && wiredName(name) === name;
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
  /** On the root: removes a node, denying its key; answers with the new invite. */
  revoke(name: string): string;
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
  /**
   * The server's public address, such as `https://robin.exe.xyz`; a relay is served there, and
   * its first label is the server's name in the network unless an owner picks one.
   */
  readonly publicUrl: () => string | undefined;
  /** Where a relay listens behind the public address; default 127.0.0.1:8790. */
  readonly relayBind?: string;
  /** Loads `@wired/node`; undefined when this release has none. */
  readonly load?: () => Promise<WiredModule | undefined>;
  readonly say?: (line: string) => void;
};

/**
 * Loads `@wired/node`: from `NUDGE_WIRED_MODULE` (a path) when set, else the copy a release ships
 * in `wired-node/`, else a checkout's `.wired-node/` (`pnpm wired:fetch`), else an installed package. Wired is optional: without it, the server serves
 * as before.
 */
export async function loadWired(): Promise<WiredModule | undefined> {
  const from = process.env.NUDGE_WIRED_MODULE;
  // A release has Node in node/bin and Wired in wired-node/; a checkout has it in .wired-node/ once
  // `pnpm wired:fetch` put it there (from packages/core/src/server or dist/server).
  const bundled = join(dirname(process.execPath), "..", "..", "wired-node", "index.js");
  const checkout = join(import.meta.dirname, "..", "..", "..", "..", ".wired-node", "index.js");
  const candidates = from
    ? [from]
    : [...[bundled, checkout].filter((path) => existsSync(path)), "@wired/node"];
  for (const candidate of candidates) {
    try {
      const module = (await import(candidate)) as { default?: WiredModule } & Partial<WiredModule>;
      const wired = (module.default ?? module) as WiredModule;
      if (typeof wired.Node?.anchor === "function") return wired;
    } catch {
      // Not there, or not loadable on this platform: try the next.
    }
  }
  return undefined;
}

/**
 * The server's own Wired (see the top of this file). A home server becomes the network's root
 * when an owner turns it on. A server made from the app joins with the invite it was given in
 * `NUDGE_WIRED_INVITE`, as `NUDGE_WIRED_NAME` when that is set, and serves a relay at its public
 * HTTPS address: `NUDGE_WIRED_RELAY_URL`, or else its public URL. Once on, it stays so across restarts.
 *
 * Its name in the network is the one an owner picked when turning it on or joining, kept in
 * `name`; else its public address's first label, or the host's. Wired keeps a key per name, so a
 * server that joins under a new name is a new member: the old name stays the network's until the
 * root removes it.
 */
export class ServerWired {
  private module: WiredModule | undefined;
  private loaded = false;
  /** Where this server's relay is reached, as its launcher said (`NUDGE_WIRED_RELAY_URL`). */
  private givenRelayUrl: string | undefined;
  /**
   * Where this server's relay listens, from just before it starts: a server joins *through* its
   * own relay, so the front must forward before the join is done.
   */
  private servingAt: string | undefined;
  private node: WiredNode | undefined;
  private agent: Agent | undefined;
  private exposed: { close(): void } | undefined;
  private starting: Promise<void> | undefined;
  private error: string | undefined;
  /** The name an owner picked, from `name`. */
  private chosenName: string | undefined;
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

  private get nameFile(): string {
    return join(this.options.dir, "name");
  }

  /** The name this server goes by in the network, or takes when it starts. */
  name(): string {
    return this.chosenName ?? serverWiredName(this.options.publicUrl());
  }

  /** Keeps `name` as the one this server goes by from now on; a name Wired accepts or a WiredError. */
  private async choose(name: string | undefined): Promise<void> {
    if (name === undefined) return;
    if (!isWiredName(name))
      throw new WiredError(
        "A name in the network is 1–63 lowercase letters, digits and dashes, such as box",
      );
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.nameFile, `${name}\n`);
    this.chosenName = name;
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
        (await readFile(this.relayUrlFile, "utf8").then(
          (s) => s.trim(),
          () => undefined,
        ));
      const chosen = await readFile(this.nameFile, "utf8").then(
        (s) => s.trim(),
        () => "",
      );
      this.chosenName = isWiredName(chosen) ? chosen : undefined;
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
   * Forwards `/relay` and `/ping` on the server's own port to its relay while it serves one: on a
   * platform with one HTTPS port, such as exe.dev, the relay shares it. Undefined without Wired.
   */
  relayFront(): RelayFront | undefined {
    const module = this.module;
    if (module === undefined) return undefined;
    let proxy: { addr: string; front: RelayFront } | undefined;
    const current = (): RelayFront | undefined => {
      const addr = this.servingAt;
      if (addr === undefined) return undefined;
      if (proxy?.addr !== addr) proxy = { addr, front: module.relayProxy(addr) };
      return proxy.front;
    };
    return {
      matches: (req) => current()?.matches(req) ?? false,
      request: (req, res) => current()?.request(req, res),
      upgrade: (req, socket, head) => current()?.upgrade(req, socket, head),
    };
  }

  /**
   * Starts again as before, or joins with `NUDGE_WIRED_INVITE` (as `NUDGE_WIRED_NAME`, when set)
   * the first time. `apiAddr` is where this server's own API listens, which the network reaches
   * as `nudge.<name>.wired`.
   */
  async resume(apiAddr: string): Promise<void> {
    if (!(await this.load())) return;
    const invite = process.env.NUDGE_WIRED_INVITE;
    if (!existsSync(this.roleFile) && invite) {
      // A name Wired wouldn't take is passed over rather than stopping the server from starting.
      const named = process.env.NUDGE_WIRED_NAME;
      if (named !== undefined && isWiredName(named)) await this.choose(named);
      else if (named) this.say(`Wired: ${named} isn't a name Wired takes; going by ${this.name()}`);
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      await writeFile(this.inviteFile, invite, { mode: 0o600 });
      if (this.givenRelayUrl) await writeFile(this.relayUrlFile, `${this.givenRelayUrl}\n`);
      await writeFile(this.roleFile, "member\n");
    }
    if (!existsSync(this.roleFile)) return;
    // In the background: a first join can take a while, and serving mustn't wait for it.
    void this.start(this.name(), apiAddr).catch(() => {});
  }

  /** Makes this server the network's root, as `name` when given. */
  async enableRoot(apiAddr: string, name?: string): Promise<WiredState> {
    if (!(await this.load())) return this.state();
    if (this.node !== undefined) {
      if (name !== undefined && name !== this.node.name)
        throw new WiredError(
          `This server is in the network as ${this.node.name} already: turn Wired off to pick another name`,
        );
      return this.state();
    }
    await this.choose(name);
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.roleFile, "root\n");
    await this.start(this.name(), apiAddr).catch(() => {});
    return this.state();
  }

  /**
   * Joins the network `invite` is for, as a member, serving a relay at this server's public HTTPS
   * address (or `relayUrl`) when it has one, as `name` when given. The root must have listed that
   * relay first.
   */
  async join(
    invite: string,
    apiAddr: string,
    { name, relayUrl }: { name?: string; relayUrl?: string } = {},
  ): Promise<WiredState> {
    if (!(await this.load())) return this.state();
    if (this.node !== undefined) throw new WiredError("This server is already in a Wired network");
    if (!/^wired1[a-z0-9]+$/.test(invite.trim())) throw new WiredError("That isn't a Wired invite");
    await this.choose(name);
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.inviteFile, invite.trim(), { mode: 0o600 });
    if (relayUrl) {
      this.givenRelayUrl = relayUrl;
      await writeFile(this.relayUrlFile, `${relayUrl}\n`);
    }
    await writeFile(this.roleFile, "member\n");
    // Joining can take a minute or two (Wired keeps trying while the root reaches this server's
    // relay): answer "starting" now; the state says when it is in.
    void this.start(this.name(), apiAddr).catch(() => {});
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

  /**
   * On the root: removes the server called `name` from the network, as when it was deleted. Its
   * key is refused from then on, and the name is free for a new server.
   */
  async remove(name: string): Promise<WiredState> {
    await this.starting;
    const node = this.node;
    if (node === undefined || !node.isRoot)
      throw new WiredError("Only the server that holds the network can remove servers from it");
    if (name === node.name)
      throw new WiredError("The server that holds the network can't remove itself");
    if (!node.members().some((m) => m.name === name))
      throw new WiredError(`No server called ${name} is in the network`);
    node.revoke(name);
    return this.state();
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
      this.servingAt = relayUrl === undefined ? undefined : this.relayBind;
      this.node =
        role === "root"
          ? await module.Node.anchor({
              name,
              stateDir,
              port: 0,
              noRelay: relayUrl === undefined,
              ...relay,
            })
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
      this.servingAt = undefined;
      const message = (error as Error).message;
      this.error = /NameTaken/.test(message)
        ? `Another server in the network is already called ${name}. Join under another name, or if it's gone, remove it on the server that holds the network, then join again.`
        : message;
      this.say(`Wired didn't start: ${this.error}`);
      throw error;
    }
  }

  state(): WiredState {
    if (this.loaded && this.module === undefined) return { state: "unavailable" };
    if (this.starting !== undefined) return { state: "starting" };
    if (this.error !== undefined) return { state: "error", name: this.name(), error: this.error };
    const node = this.node;
    if (node === undefined) return { state: "off", name: this.name() };
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
    this.servingAt = undefined;
    this.exposed?.close();
    await this.agent?.close();
    await this.node?.close();
    this.node = undefined;
    this.agent = undefined;
  }

  /**
   * Turns Wired off here: forgets the role, the invite and any network it held. Its name and key
   * stay, so joining again later under that name is the same server, which a network still has
   * registered to that key.
   */
  async forget(): Promise<void> {
    await this.starting?.catch(() => {});
    await this.stop();
    this.error = undefined;
    this.givenRelayUrl = undefined;
    for (const file of [this.roleFile, this.inviteFile, this.relayUrlFile])
      await rm(file, { force: true });
    await rm(join(this.options.dir, "state", "anchor"), { recursive: true, force: true });
  }
}

/** The name a server goes by in the network: its public address's first label, or the host's. */
export function serverWiredName(publicUrl: string | undefined): string {
  const label = /^https?:\/\/([a-z0-9-]+)/i.exec(publicUrl ?? "")?.[1];
  return wiredName(label ?? hostname().split(".")[0] ?? "nudge");
}

/**
 * Routes this process's requests: to `*.wired` hosts over `wired()` (the server's Wired), and the
 * rest as before. `fetch` everywhere in the process, extensions' included, goes through it.
 */
export function routeOutgoing(wired: () => Dispatcher | undefined): void {
  setGlobalDispatcher(new OutgoingDispatcher(new Agent(), wired));
}

class OutgoingDispatcher extends Dispatcher {
  constructor(
    private readonly direct: Dispatcher,
    private readonly wired: () => Dispatcher | undefined,
  ) {
    super();
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
    return this.pick(options.origin).dispatch(options, handler);
  }

  override close(): Promise<void> {
    return this.direct.close();
  }

  override destroy(): Promise<void> {
    return this.direct.destroy();
  }

  private pick(origin: Dispatcher.DispatchOptions["origin"]): Dispatcher {
    if (origin === undefined) return this.direct;
    const host = (typeof origin === "string" ? new URL(origin) : origin).hostname;
    return isWiredHost(host) ? (this.wired() ?? this.direct) : this.direct;
  }
}
