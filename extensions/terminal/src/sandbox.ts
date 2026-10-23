// A command in a bubblewrap sandbox: the system's programs read-only, the room's workspace at
// /workspace, an empty /tmp, none of Nudge's files or environment, and the network only when the
// settings give it. Limits on time, CPU, memory, processes, file size and the workspace's size keep
// one command from the host.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { posix } from "node:path";
import type { Readable, Writable } from "node:stream";

/** Where the workspace is inside the sandbox; commands see no other path of the machine. */
export const WORKSPACE = "/workspace";

/** Where commands in the sandbox find programs. */
const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin";

/** Where the room's desktop's home is inside the sandbox, when the settings share it. */
export const DESKTOP = "/desktop";

/**
 * What of the network commands reach: none; the internet only, through slirp4netns with this
 * machine and private addresses blocked; or all of it, as the server does.
 */
export type Network = "off" | "internet" | "all";

/**
 * Addresses a command with the `internet` network never reaches: this machine (slirp4netns's
 * 10.0.2.2), the local network, link-local (cloud metadata), CGNAT (Tailscale) and the rest of
 * the private and reserved ranges. slirp4netns's own network, 10.0.2.0/24, is more specific than
 * 10.0.0.0/8 and so stays reachable for its DNS at 10.0.2.3.
 */
export const BLOCKED = [
  "10.0.2.2/32",
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

export interface SandboxOptions {
  /** The room's workspace on this machine, mounted at /workspace. */
  workspace: string;
  /** The working directory inside the sandbox, /workspace or under it. */
  cwd?: string;
  network: Network;
  /** The room's desktop's home on this machine, mounted at /desktop when it exists. */
  desktop?: string;
  /** More directories commands may read, at the same paths. */
  readable?: readonly string[];
  timeoutMs: number;
  /** Most characters of output kept: the start and the end, with what's between cut. */
  maxOutput: number;
  /** Most bytes of any one file a command writes. */
  maxFileBytes?: number;
  /**
   * Most bytes of memory a command uses: all it starts together, in a cgroup of its own when the
   * server's systemd gives one, or else each of its processes on its own (`ulimit -v`). /tmp, kept
   * in memory, holds at most as much.
   */
  maxMemoryBytes?: number;
  /** Most bytes the workspace holds; a command that grows it past that is stopped. */
  maxWorkspaceBytes?: number;
  signal?: AbortSignal;
  /** Hears the start of the output as it comes, the part that is kept. */
  onOutput?: (chunk: string) => void;
}

export interface CommandResult {
  /** The exit code, or undefined when the command was stopped. */
  exitCode: number | undefined;
  /** stdout and stderr together, in the order they came. */
  output: string;
  /** Characters cut from the middle of the output. */
  cut: number;
  timedOut: boolean;
  aborted: boolean;
  /** Stopped for growing the workspace past `maxWorkspaceBytes`. */
  workspaceFull: boolean;
}

/** Most bytes of memory a command uses when the options don't say. */
export const MAX_MEMORY = 2 * 1024 ** 3;

/** Most bytes a workspace holds when the options don't say. */
export const MAX_WORKSPACE = 2 * 1024 ** 3;

/** How often a running command's workspace is measured, in milliseconds. */
const WORKSPACE_CHECK_MS = 1_000;

let checked: { problem: string | undefined } | undefined;

/** Why commands can't run in a sandbox here, if they can't; checked once. */
export function sandboxProblem(): string | undefined {
  checked ??= {
    problem: !onPath("bwrap")
      ? "This server has no bubblewrap (bwrap), which the terminal runs every command in. Install bubblewrap."
      : !onPath("bash")
        ? "This server has no bash for the terminal's commands."
        : spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--unshare-all", "true"], {
              stdio: "ignore",
              timeout: 5_000,
            }).status !== 0
          ? "bubblewrap can't make a sandbox on this server: it needs user namespaces, which this system or container doesn't allow. In Docker, add the security_opt lines from Nudge's compose.yaml; otherwise allow them."
          : undefined,
  };
  return checked.problem;
}

/** Which of these programs commands in the sandbox find, in order. */
export function installed(programs: readonly string[]): string[] {
  const dirs = SANDBOX_PATH.split(":");
  return programs.filter((program) => dirs.some((dir) => existsSync(`${dir}/${program}`)));
}

let checkedNetwork: { problem: string | undefined } | undefined;

/** Why commands can't have the `internet` network here, if they can't; checked once. */
export function networkProblem(): string | undefined {
  checkedNetwork ??= {
    problem: ["slirp4netns", "nsenter", "ip"].some((program) => !onPath(program))
      ? `The terminal's internet without this machine and the local network needs slirp4netns, nsenter (util-linux) and ip (iproute2) on this server. Install them, or turn the terminal's "localNetwork" setting on, or "network" off.`
      : !existsSync("/dev/net/tun")
        ? `The terminal's internet needs /dev/net/tun for slirp4netns, which this server or container doesn't have. In Docker, add the devices line from Nudge's compose.yaml; or turn the terminal's "localNetwork" setting on, or "network" off.`
        : undefined,
  };
  return checkedNetwork.problem;
}

/** The working directory inside the sandbox for `cwd`, relative to /workspace or under it. */
export function workingDirectory(cwd: string | undefined): string {
  const path = posix.resolve(WORKSPACE, cwd ?? ".");
  if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`))
    throw new Error(`The working directory has to be in ${WORKSPACE}; ${cwd} is not.`);
  return path;
}

let checkedScope: { works: boolean } | undefined;

/**
 * Whether commands get a cgroup with a memory cap of their own, through `systemd-run --user
 * --scope`: on a systemd host with the memory controller delegated to the user, not in Docker.
 * Checked once, by reading the cap back from inside such a scope.
 */
export function memoryScope(): boolean {
  checkedScope ??= {
    works:
      onPath("systemd-run") &&
      spawnSync(
        "systemd-run",
        [
          ...scopeArgs(64 * 1024 ** 2),
          "sh",
          "-c",
          'read -r line < /proc/self/cgroup && cat "/sys/fs/cgroup/${line#0::}/memory.max"',
        ],
        { encoding: "utf8", timeout: 5_000, env: scopeEnv() },
      ).stdout?.trim() === String(64 * 1024 ** 2),
  };
  return checkedScope.works;
}

/** systemd-run's arguments for a scope that holds the command it then runs to `bytes` of memory. */
function scopeArgs(bytes: number): string[] {
  return [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    // The command's own text, not systemd's to expand; a systemd too old for this isn't used.
    "--expand-environment=no",
    "-p",
    `MemoryMax=${bytes}`,
    "-p",
    "MemorySwapMax=0",
    "--",
  ];
}

/** What of Nudge's environment systemd-run needs to reach the user's systemd; bubblewrap clears it. */
function scopeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

let checkedSize: { works: boolean } | undefined;

/** Whether this bubblewrap sizes a tmpfs (`--size`, 0.10 and later; Debian 12 has 0.8). */
export function tmpfsSize(): boolean {
  checkedSize ??= {
    works: /--size\b/.test(
      spawnSync("bwrap", ["--help"], { encoding: "utf8", timeout: 5_000 }).stdout ?? "",
    ),
  };
  return checkedSize.works;
}

/**
 * The bytes a directory takes on disk, with all under it; links aren't followed, and a file with
 * several hard links counts once. What vanishes while it is counted counts nothing.
 */
export async function workspaceBytes(dir: string): Promise<number> {
  const seen = new Set<string>();
  const walk = async (path: string): Promise<number> => {
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      return 0;
    }
    if (stat.nlink > 1 && !stat.isDirectory()) {
      const key = `${stat.dev}:${stat.ino}`;
      if (seen.has(key)) return 0;
      seen.add(key);
    }
    let bytes = stat.blocks * 512;
    if (stat.isDirectory()) {
      let names: string[] = [];
      try {
        names = await readdir(path);
      } catch {
        // Unreadable or gone: what it holds isn't counted.
      }
      for (const name of names) bytes += await walk(`${path}/${name}`);
    }
    return bytes;
  };
  return walk(dir);
}

/** bubblewrap's arguments: what of the machine a command sees. */
export function sandboxArgs(options: SandboxOptions): string[] {
  // /tmp and /run are in memory, so they hold no more than a command may use.
  const sized = tmpfsSize() ? ["--size", String(options.maxMemoryBytes ?? MAX_MEMORY)] : [];
  const system = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];
  // Fonts' caches, and where /etc/resolv.conf points on systemd hosts.
  const extra = ["/var/cache/fontconfig", "/run/systemd/resolve", ...(options.readable ?? [])];
  return [
    "--die-with-parent",
    // No TIOCSTI into Nudge's terminal.
    "--new-session",
    "--unshare-all",
    ...(options.network === "all" ? ["--share-net"] : []),
    // For the internet, root of its user namespace, so slirp4netns and `ip` can join it and set
    // up its network (bubblewrap nests a second one for any other uid), with no capabilities, so
    // its commands can't undo that.
    ...(options.network === "internet" ? ["--uid", "0", "--gid", "0", "--cap-drop", "ALL"] : []),
    "--hostname",
    "nudge",
    "--clearenv",
    "--setenv",
    "PATH",
    SANDBOX_PATH,
    "--setenv",
    "HOME",
    WORKSPACE,
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "TERM",
    "dumb",
    "--setenv",
    "TMPDIR",
    "/tmp",
    ...system.flatMap((path) => ["--ro-bind-try", path, path]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...sized,
    "--tmpfs",
    "/tmp",
    ...sized,
    "--tmpfs",
    "/run",
    ...extra.flatMap((path) => ["--ro-bind-try", path, path]),
    "--bind",
    options.workspace,
    WORKSPACE,
    ...(options.desktop ? ["--bind-try", options.desktop, DESKTOP] : []),
    "--chdir",
    workingDirectory(options.cwd),
  ];
}

/** Runs a command with bash in the sandbox and gives back its output and exit code. */
export async function runSandboxed(
  command: string,
  options: SandboxOptions,
): Promise<CommandResult> {
  const filtered = options.network === "internet";
  const problem = filtered ? networkProblem() : undefined;
  if (problem) throw new Error(problem);
  mkdirSync(options.workspace, { recursive: true });
  const cwd = workingDirectory(options.cwd);
  const fileBlocks = Math.ceil((options.maxFileBytes ?? 1024 ** 3) / 1024);
  const cpuSeconds = Math.ceil(options.timeoutMs / 1000) + 1;
  const memory = options.maxMemoryBytes ?? MAX_MEMORY;
  const scoped = memoryScope();
  // Without a cgroup, each process gets the memory on its own: less of a cap, but still one.
  const perProcess = scoped ? "" : ` -v ${Math.ceil(memory / 1024)}`;
  // Limits first, in the same shell; the command's own text follows as bash reads it.
  const script = `ulimit -t ${cpuSeconds} -f ${fileBlocks} -u 512${perProcess} 2>/dev/null\n${command}`;
  const maxWorkspace = options.maxWorkspaceBytes ?? MAX_WORKSPACE;
  // A workspace already over can still be cleared up; it just mustn't grow.
  const allowed = Math.max(maxWorkspace, await workspaceBytes(options.workspace));
  const child = spawn(
    scoped ? "systemd-run" : "bwrap",
    [
      ...(scoped ? [...scopeArgs(memory), "bwrap"] : []),
      ...sandboxArgs({ ...options, cwd }),
      // With the internet: its pid on 3, then it waits on 4 for its network; resolv.conf from 5.
      ...(filtered
        ? ["--info-fd", "3", "--block-fd", "4", "--ro-bind-data", "5", resolvConf()]
        : []),
      "--",
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      script,
    ],
    // Nudge's environment, its keys included, stays out; bubblewrap clears it inside too.
    {
      stdio: ["ignore", "pipe", "pipe", ...(filtered ? (["pipe", "pipe", "pipe"] as const) : [])],
      detached: true,
      env: scoped ? scopeEnv() : { PATH: process.env.PATH ?? "" },
    },
  );
  const output = new Output(options.maxOutput, options.onOutput);
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => output.add(chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => output.add(chunk));
  let timedOut = false;
  let aborted = false;
  let workspaceFull = false;
  const stop = () => {
    // The whole group: bubblewrap, and with it everything in the sandbox.
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  let failed: Error | undefined;
  const network = filtered
    ? connectToInternet(child).catch((error: Error) => {
        failed = new Error(`It got no network: ${error.message}`);
        stop();
        return undefined;
      })
    : undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  // No quota without root, so the workspace is measured as the command runs.
  let measuring = false;
  let ended = false;
  const watch = setInterval(() => {
    if (measuring) return;
    measuring = true;
    void workspaceBytes(options.workspace).then((bytes) => {
      measuring = false;
      if (bytes > allowed && !workspaceFull && !ended) {
        workspaceFull = true;
        stop();
      }
    });
  }, WORKSPACE_CHECK_MS);
  const onAbort = () => {
    aborted = true;
    stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return new Promise((resolve, reject) => {
    const done = () => {
      ended = true;
      clearTimeout(timer);
      clearInterval(watch);
      options.signal?.removeEventListener("abort", onAbort);
      void network?.then((slirp) => slirp?.kill("SIGKILL"));
    };
    child.once("error", (error) => {
      done();
      reject(error);
    });
    child.once("close", (code) => {
      done();
      if (failed) return reject(failed);
      resolve({
        exitCode: timedOut || aborted || workspaceFull || code === null ? undefined : code,
        output: output.text(),
        cut: output.cut,
        timedOut,
        aborted,
        workspaceFull,
      });
    });
  });
}

/**
 * Gives a sandbox that waits on its block fd the internet: slirp4netns makes it a network that
 * goes out through this machine's, without reaching this machine's own services, and `ip` blocks
 * the private and reserved ranges in it. Resolves with slirp4netns, to stop once the command ends.
 */
async function connectToInternet(child: ChildProcess): Promise<ChildProcess> {
  const [info, block, resolv] = [3, 4, 5].map((fd) => child.stdio[fd]) as [
    Readable,
    Writable,
    Writable,
  ];
  // A sandbox that ends early closes these; that's for `close` to report, not a crash.
  for (const stream of [info, block, resolv]) stream.on("error", () => {});
  resolv.end("nameserver 10.0.2.3\n");
  const pid = await sandboxPid(info);
  const slirp = spawn(
    "slirp4netns",
    ["--configure", "--mtu=65520", "--disable-host-loopback", "--ready-fd=3", String(pid), "tap0"],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  try {
    await slirpReady(slirp);
    await runWith(
      "nsenter",
      ["--target", String(pid), "--user", "--net", "--preserve-credentials", "ip", "-batch", "-"],
      ["link set lo up\n", ...BLOCKED.map((range) => `route add prohibit ${range}\n`)].join(""),
    );
    block.end("1");
    return slirp;
  } catch (error) {
    slirp.kill("SIGKILL");
    throw error;
  }
}

/**
 * Where /etc/resolv.conf's text is, for slirp4netns's DNS to take its place: bubblewrap can't mount
 * on a link, and on systemd hosts it links to /run/systemd/resolve.
 */
function resolvConf(): string {
  let path = "/etc/resolv.conf";
  for (let links = 0; links < 10; links++) {
    try {
      if (!lstatSync(path).isSymbolicLink()) break;
    } catch {
      break;
    }
    path = posix.resolve(posix.dirname(path), readlinkSync(path));
  }
  return path;
}

/** The sandbox's pid, from bubblewrap's info fd. */
function sandboxPid(info: Readable): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("bubblewrap didn't start")), 5_000);
    info.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      try {
        const pid = (JSON.parse(text) as { "child-pid"?: number })["child-pid"];
        if (typeof pid === "number") {
          clearTimeout(timer);
          resolve(pid);
        }
      } catch {
        // Not all of it yet.
      }
    });
    info.once("close", () => {
      clearTimeout(timer);
      reject(new Error("bubblewrap ended before it started"));
    });
  });
}

/** Waits for slirp4netns to have set the network up. */
function slirpReady(slirp: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let errors = "";
    slirp.stderr!.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
    const timer = setTimeout(() => reject(new Error("slirp4netns didn't start")), 5_000);
    slirp.stdio[3]!.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    slirp.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    slirp.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`slirp4netns failed: ${errors.trim() || "no reason given"}`));
    });
  });
}

/** Runs a program with `input`; rejects with what it said when it fails. */
function runWith(program: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${program} failed: ${errors.trim() || `exit code ${code}`}`)),
    );
  });
}

/** What of the sandbox moving a file in or out of it sees. */
export type FileOptions = Pick<
  SandboxOptions,
  "workspace" | "desktop" | "readable" | "maxWorkspaceBytes"
>;

/**
 * A file's bytes, read in the sandbox, so a path or link in the workspace never reaches beyond
 * what commands see. `path` is relative to /workspace or absolute in the sandbox.
 */
export async function readFromSandbox(
  path: string,
  options: FileOptions,
  maxBytes: number,
): Promise<Buffer> {
  const script = `[ -f "$1" ] || { echo "$1 is not a file" >&2; exit 2; }
size=$(stat -L -c %s -- "$1") || exit 2
[ "$size" -le "$2" ] || { echo "$1 is $size bytes, over the $2 allowed" >&2; exit 3; }
exec head -c "$2" -- "$1"`;
  return (await inSandbox(script, [path, String(maxBytes)], options)).subarray(0, maxBytes);
}

/**
 * Writes a new file in the sandbox, making its directory; never over a file that is there.
 * Gives the file's path in the sandbox.
 */
export async function writeToSandbox(
  path: string,
  bytes: Uint8Array,
  options: FileOptions,
): Promise<string> {
  const max = options.maxWorkspaceBytes ?? MAX_WORKSPACE;
  const used = await workspaceBytes(options.workspace);
  if (used + bytes.length > max)
    throw new Error(
      `the workspace would hold ${megabytes(used + bytes.length)} MB, over the ${megabytes(max)} MB allowed; delete files from it first`,
    );
  const script = `mkdir -p -- "$(dirname -- "$1")" || exit 2
set -o noclobber
cat > "$1" || exit 2
realpath -- "$1"`;
  return (await inSandbox(script, [path], options, bytes)).toString("utf8").trim();
}

/** Runs a short bash script in the sandbox, without network; rejects with its errors. */
function inSandbox(
  script: string,
  args: string[],
  options: FileOptions,
  input?: Uint8Array,
): Promise<Buffer> {
  mkdirSync(options.workspace, { recursive: true });
  const child = spawn(
    "bwrap",
    [
      ...sandboxArgs({ ...options, network: "off", timeoutMs: 0, maxOutput: 0 }),
      "--",
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      script,
      "bash",
      ...args,
    ],
    { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
  );
  const out: Buffer[] = [];
  let errors = "";
  child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  if (input && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else
        reject(
          new Error(
            errors.replace(/^bash: (line \d+: )?/gm, "").trim() ||
              (code === null ? "it took too long" : `exit code ${code}`),
          ),
        );
    });
  });
}

/** The start and the end of a command's output, within `max` characters. */
class Output {
  private head = "";
  private tail = "";
  cut = 0;
  private readonly max: number;
  private readonly onOutput: ((chunk: string) => void) | undefined;

  constructor(max: number, onOutput?: (chunk: string) => void) {
    this.max = max;
    this.onOutput = onOutput;
  }

  add(chunk: string): void {
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.onOutput?.(chunk.slice(0, room));
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    const over = this.tail.length - (this.max - half);
    if (over > 0) {
      this.tail = this.tail.slice(over);
      this.cut += over;
    }
  }

  text(): string {
    if (!this.cut) return this.head + this.tail;
    return `${this.head}\n… (${this.cut} characters cut) …\n${this.tail}`;
  }
}

/** Bytes as whole megabytes, rounded up. */
export function megabytes(bytes: number): number {
  return Math.ceil(bytes / 1024 ** 2);
}

function onPath(program: string): boolean {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((dir) => existsSync(`${dir}/${program}`));
}
