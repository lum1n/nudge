import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici";

/** What the server API shows of the server's own Tailscale. */
export type TailscaleState = {
  /**
   * `off`: not asked for; `starting`: being installed or started; `needs-login`: someone has to
   * approve it at `authUrl`; `needs-approval`: a tailnet admin has to approve the machine;
   * `connected`: in the tailnet as `name`; `error`: it failed, see `error`.
   */
  readonly state: "off" | "starting" | "needs-login" | "needs-approval" | "connected" | "error";
  readonly authUrl?: string;
  /** Its MagicDNS name, such as `nudge-robin.tail1234.ts.net`. */
  readonly name?: string;
  readonly addresses?: string[];
  readonly error?: string;
};

export class TailscaleError extends Error {
  override name = "TailscaleError";
}

/** Where Tailscale publishes its static Linux builds. */
export const TAILSCALE_PACKAGES = "https://pkgs.tailscale.com/stable/";

/**
 * Whether `hostname` is in a tailnet: a MagicDNS name, or an address Tailscale hands out
 * (100.64.0.0/10, fd7a:115c:a1e0::/48). Other servers are reached as usual.
 */
export function isTailnetHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.endsWith(".ts.net")) return true;
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4 !== undefined && v4 !== null) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return host.startsWith("fd7a:115c:a1e0:");
}

/** The state `tailscale status --json` describes. */
export function stateOfStatus(status: unknown): TailscaleState {
  const s = (status ?? {}) as {
    BackendState?: string;
    AuthURL?: string;
    TailscaleIPs?: string[] | null;
    Self?: { DNSName?: string };
  };
  switch (s.BackendState) {
    case "Running":
      return {
        state: "connected",
        ...(s.Self?.DNSName ? { name: s.Self.DNSName.replace(/\.$/, "") } : {}),
        addresses: s.TailscaleIPs ?? [],
      };
    case "NeedsLogin":
      return s.AuthURL ? { state: "needs-login", authUrl: s.AuthURL } : { state: "starting" };
    case "NeedsMachineAuth":
      return { state: "needs-approval" };
    default:
      return { state: "starting" };
  }
}

export type TailscaleOptions = {
  /** Where its binaries, state and socket go: `server/tailscale` beside the config. */
  readonly dir: string;
  /** The machine's name in the tailnet, asked when it connects. */
  readonly hostname: () => string;
  /** Such as `x64`, as `process.arch` says. */
  readonly arch?: string;
  readonly fetch?: typeof fetch;
  readonly say?: (line: string) => void;
  /** Runs the `tailscale` CLI, answering what it printed; tests pass a fake. */
  readonly run?: (bin: string, args: string[], timeoutMs: number) => Promise<string>;
  /** Starts `tailscaled`; tests pass a fake. */
  readonly daemon?: (bin: string, args: string[]) => ChildProcess;
  readonly now?: () => number;
};

const ARCHES: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/**
 * The server's own Tailscale (ADR 11), so it can reach assistants that are only in its owner's
 * tailnet. It runs `tailscaled` in userspace mode, which needs no root or TUN device, as the
 * server's own user; Tailscale's static build is downloaded the first time. Outgoing requests
 * to tailnet addresses go through its HTTP proxy (`routeTailnet`), the rest as before. Once
 * connected it stays so across restarts, until an owner disconnects it.
 */
export class Tailscale {
  private child: ChildProcess | undefined;
  private bin: string | undefined;
  private proxyPort: number | undefined;
  private starting: Promise<void> | undefined;
  private error: string | undefined;
  private log: string[] = [];
  private readonly fetcher: typeof fetch;
  private readonly say: (line: string) => void;
  private readonly run: (bin: string, args: string[], timeoutMs: number) => Promise<string>;
  private readonly daemon: (bin: string, args: string[]) => ChildProcess;

  constructor(private readonly options: TailscaleOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.say = options.say ?? (() => {});
    this.run =
      options.run ??
      (async (bin, args, timeout) =>
        (await promisify(execFile)(bin, args, { timeout, maxBuffer: 4 << 20 })).stdout);
    this.daemon =
      options.daemon ?? ((bin, args) => spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] }));
  }

  private get enabledFile(): string {
    return join(this.options.dir, "enabled");
  }

  private get socket(): string {
    return join(this.options.dir, "tailscaled.sock");
  }

  /** Whether an owner connected it, and hasn't disconnected it since. */
  get enabled(): boolean {
    return existsSync(this.enabledFile);
  }

  /** `http://127.0.0.1:<port>` while `tailscaled` runs: its proxy into the tailnet. */
  get proxy(): string | undefined {
    return this.child !== undefined && this.proxyPort !== undefined
      ? `http://127.0.0.1:${this.proxyPort}`
      : undefined;
  }

  /** Starts it again when the server starts, if an owner connected it before. */
  async resume(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureDaemon();
    } catch (error) {
      this.error = (error as Error).message;
      this.say(`Tailscale didn't start: ${this.error}`);
    }
  }

  async state(): Promise<TailscaleState> {
    if (!this.enabled) return { state: "off" };
    if (this.error !== undefined && this.child === undefined)
      return { state: "error", error: this.error };
    if (this.child === undefined) return { state: "starting" };
    try {
      return stateOfStatus(JSON.parse(await this.cli(["status", "--json"])));
    } catch (error) {
      return { state: "starting", error: (error as Error).message };
    }
  }

  /**
   * Joins the tailnet: with `authKey` at once, else with a login URL someone approves, which
   * the state shows while it waits. Installs and starts `tailscaled` first, if need be.
   */
  async connect(authKey?: string): Promise<TailscaleState> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.enabledFile, "");
    this.error = undefined;
    try {
      await this.ensureDaemon();
    } catch (error) {
      this.error = (error as Error).message;
      return { state: "error", error: this.error };
    }
    const current = await this.state();
    if (current.state === "connected" && authKey === undefined) return current;
    const args = ["up", `--hostname=${this.options.hostname()}`, "--accept-dns=false"];
    if (authKey !== undefined) args.push(`--auth-key=${authKey}`);
    // `up` waits until the login is approved, so it runs on while the state shows the URL.
    void this.cli(args, 10 * 60_000).catch((error: Error) => {
      if (this.child !== undefined) this.error = lastLine(error.message);
    });
    const deadline = (this.options.now ?? Date.now)() + 15_000;
    while ((this.options.now ?? Date.now)() < deadline) {
      const state = await this.state();
      if (state.state !== "starting") return state;
      if (this.error !== undefined) return { state: "error", error: this.error };
      await delay(500);
    }
    return this.state();
  }

  /** Leaves the tailnet and stops `tailscaled`; the binaries stay for next time. */
  async disconnect(): Promise<TailscaleState> {
    if (this.child !== undefined) await this.cli(["logout"]).catch(() => {});
    this.stop();
    await rm(this.enabledFile, { force: true });
    await rm(join(this.options.dir, "state"), { recursive: true, force: true });
    this.error = undefined;
    return { state: "off" };
  }

  /** Stops `tailscaled`, as the server stops; it stays connected for the next start. */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.proxyPort = undefined;
    child?.kill("SIGTERM");
  }

  private ensureDaemon(): Promise<void> {
    if (this.child !== undefined) return Promise.resolve();
    this.starting ??= this.startDaemon().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startDaemon(): Promise<void> {
    const bin = await this.install();
    const port = await freePort();
    const dir = this.options.dir;
    await rm(this.socket, { force: true });
    const child = this.daemon(join(bin, "tailscaled"), [
      "--tun=userspace-networking",
      `--statedir=${join(dir, "state")}`,
      `--socket=${this.socket}`,
      `--outbound-http-proxy-listen=127.0.0.1:${port}`,
      "--port=0",
    ]);
    this.log = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.log = [...this.log, ...chunk.split("\n").filter((line) => line !== "")].slice(-20);
    });
    const stopped = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.proxyPort = undefined;
      this.error = `tailscaled stopped (${why}): ${this.log.at(-1) ?? ""}`.trim();
      this.say(this.error);
    };
    child.once("exit", (code) => stopped(String(code ?? "signal")));
    // Such as a binary that can't run here; without a listener it would end the server.
    child.once("error", (error) => stopped(error.message));
    this.child = child;
    this.proxyPort = port;
    this.bin = bin;
    // Ready once its CLI gets an answer.
    for (let tries = 0; ; tries++) {
      try {
        await this.cli(["status", "--json"]);
        return;
      } catch (error) {
        if (this.child !== child) throw new TailscaleError(this.error ?? "tailscaled stopped");
        if (tries >= 40) {
          this.stop();
          throw new TailscaleError(
            `tailscaled didn't answer: ${lastLine((error as Error).message)}`,
          );
        }
        await delay(250);
      }
    }
  }

  private cli(args: string[], timeoutMs = 30_000): Promise<string> {
    if (this.bin === undefined)
      return Promise.reject(new TailscaleError("Tailscale isn't installed"));
    return this.run(join(this.bin, "tailscale"), [`--socket=${this.socket}`, ...args], timeoutMs);
  }

  /**
   * The directory with `tailscale` and `tailscaled`: the newest stable build, downloaded and
   * checked against the hash Tailscale publishes beside it, unless one is there already.
   */
  private async install(): Promise<string> {
    const binDir = join(this.options.dir, "bin");
    if (existsSync(join(binDir, "tailscaled")) && existsSync(join(binDir, "tailscale")))
      return binDir;
    const arch = ARCHES[this.options.arch ?? process.arch];
    if (arch === undefined)
      throw new TailscaleError(`No Tailscale build for ${this.options.arch ?? process.arch}`);
    const index = (await this.get(`${TAILSCALE_PACKAGES}?mode=json`).then((r) => r.json())) as {
      Tarballs?: Record<string, string>;
    };
    const file = index.Tarballs?.[arch];
    if (file === undefined || !/^tailscale_[\w.]+\.tgz$/.test(file))
      throw new TailscaleError(`Tailscale lists no build for ${arch}`);
    const expected = (await (await this.get(`${TAILSCALE_PACKAGES}${file}.sha256`)).text())
      .trim()
      .split(/\s+/)[0];
    const archive = Buffer.from(
      await (await this.get(`${TAILSCALE_PACKAGES}${file}`)).arrayBuffer(),
    );
    if (createHash("sha256").update(archive).digest("hex") !== expected)
      throw new TailscaleError("The Tailscale download isn't the one Tailscale published");
    const unpacking = `${binDir}.unpacking`;
    await rm(unpacking, { recursive: true, force: true });
    await mkdir(unpacking, { recursive: true });
    try {
      const tgz = join(unpacking, file);
      await writeFile(tgz, archive);
      await promisify(execFile)("tar", ["-xzf", tgz, "-C", unpacking, "--strip-components=1"]);
      for (const name of ["tailscale", "tailscaled"]) {
        if (!existsSync(join(unpacking, name)))
          throw new TailscaleError(`The Tailscale download has no ${name}`);
        await chmod(join(unpacking, name), 0o755);
      }
      await rm(tgz, { force: true });
      await rm(binDir, { recursive: true, force: true });
      await rename(unpacking, binDir);
    } finally {
      await rm(unpacking, { recursive: true, force: true });
    }
    this.say(`Installed Tailscale from ${file}`);
    return binDir;
  }

  private async get(url: string): Promise<Response> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new TailscaleError(`${url} answered ${response.status}`);
    return response;
  }
}

/**
 * Sends this process's requests to tailnet addresses through `proxy()` while it gives one, and
 * the rest as before; `fetch` everywhere in the process, extensions' included, goes through it.
 */
export function routeTailnet(proxy: () => string | undefined): void {
  setGlobalDispatcher(new TailnetDispatcher(new Agent(), proxy));
}

class TailnetDispatcher extends Dispatcher {
  private agent: { url: string; dispatcher: ProxyAgent } | undefined;

  constructor(
    private readonly direct: Dispatcher,
    private readonly proxy: () => string | undefined,
  ) {
    super();
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
    return this.pick(options.origin).dispatch(options, handler);
  }

  override close(): Promise<void> {
    return Promise.all([this.direct.close(), this.agent?.dispatcher.close()]).then(() => {});
  }

  override destroy(): Promise<void> {
    return Promise.all([this.direct.destroy(), this.agent?.dispatcher.destroy()]).then(() => {});
  }

  private pick(origin: Dispatcher.DispatchOptions["origin"]): Dispatcher {
    const url = this.proxy();
    if (url === undefined || origin === undefined) return this.direct;
    const host = (typeof origin === "string" ? new URL(origin) : origin).hostname;
    if (!isTailnetHost(host)) return this.direct;
    if (this.agent?.url !== url) {
      void this.agent?.dispatcher.close();
      this.agent = { url, dispatcher: new ProxyAgent(url) };
    }
    return this.agent.dispatcher;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new TailscaleError("No free port")),
      );
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? text
  );
}
