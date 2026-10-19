// A command in a bubblewrap sandbox: the system's programs read-only, the room's workspace at
// /workspace, an empty /tmp, none of Nudge's files or environment, and the network only when the
// settings give it. Limits on time, CPU, processes and file size keep one command from the host.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { posix } from "node:path";

/** Where the workspace is inside the sandbox; commands see no other path of the machine. */
export const WORKSPACE = "/workspace";

export interface SandboxOptions {
  /** The room's workspace on this machine, mounted at /workspace. */
  workspace: string;
  /** The working directory inside the sandbox, /workspace or under it. */
  cwd?: string;
  network: boolean;
  /** More directories commands may read, at the same paths. */
  readable?: readonly string[];
  timeoutMs: number;
  /** Most characters of output kept: the start and the end, with what's between cut. */
  maxOutput: number;
  /** Most bytes of any one file a command writes. */
  maxFileBytes?: number;
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
}

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

/** The working directory inside the sandbox for `cwd`, relative to /workspace or under it. */
export function workingDirectory(cwd: string | undefined): string {
  const path = posix.resolve(WORKSPACE, cwd ?? ".");
  if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`))
    throw new Error(`The working directory has to be in ${WORKSPACE}; ${cwd} is not.`);
  return path;
}

/** bubblewrap's arguments: what of the machine a command sees. */
export function sandboxArgs(options: SandboxOptions): string[] {
  const system = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];
  // Fonts' caches, and where /etc/resolv.conf points on systemd hosts.
  const extra = ["/var/cache/fontconfig", "/run/systemd/resolve", ...(options.readable ?? [])];
  return [
    "--die-with-parent",
    // No TIOCSTI into Nudge's terminal.
    "--new-session",
    "--unshare-all",
    ...(options.network ? ["--share-net"] : []),
    "--hostname",
    "nudge",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
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
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    ...extra.flatMap((path) => ["--ro-bind-try", path, path]),
    "--bind",
    options.workspace,
    WORKSPACE,
    "--chdir",
    workingDirectory(options.cwd),
  ];
}

/** Runs a command with bash in the sandbox and gives back its output and exit code. */
export async function runSandboxed(
  command: string,
  options: SandboxOptions,
): Promise<CommandResult> {
  mkdirSync(options.workspace, { recursive: true });
  const cwd = workingDirectory(options.cwd);
  const fileBlocks = Math.ceil((options.maxFileBytes ?? 1024 ** 3) / 1024);
  const cpuSeconds = Math.ceil(options.timeoutMs / 1000) + 1;
  // Limits first, in the same shell; the command's own text follows as bash reads it.
  const script = `ulimit -t ${cpuSeconds} -f ${fileBlocks} -u 512 2>/dev/null\n${command}`;
  const child = spawn(
    "bwrap",
    [...sandboxArgs({ ...options, cwd }), "--", "bash", "--noprofile", "--norc", "-c", script],
    // Nudge's environment, its keys included, stays out; bubblewrap clears it inside too.
    { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { PATH: process.env.PATH ?? "" } },
  );
  const output = new Output(options.maxOutput, options.onOutput);
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => output.add(chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => output.add(chunk));
  let timedOut = false;
  let aborted = false;
  const stop = () => {
    // The whole group: bubblewrap, and with it everything in the sandbox.
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = () => {
    aborted = true;
    stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: timedOut || aborted || code === null ? undefined : code,
        output: output.text(),
        cut: output.cut,
        timedOut,
        aborted,
      });
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

function onPath(program: string): boolean {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((dir) => existsSync(`${dir}/${program}`));
}
