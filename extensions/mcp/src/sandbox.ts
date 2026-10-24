// A started MCP server in a bubblewrap sandbox, as the terminal's commands: the system's programs
// read-only, its own home and working directory writable, an empty /tmp, and none of Nudge's
// files (its database, keys and the extensions' secrets). It has the network, which servers
// need to reach the services they speak for.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

/** Where a sandboxed program reads and writes. */
export type Sandbox = {
  /** Its home, writable, at the same path; made when missing. An empty one in /tmp when left out. */
  readonly home?: string;
  /** Its working directory, writable, at the same path; the home when left out. */
  readonly cwd?: string;
  /** More directories it may read, at the same paths, such as where node or uv is installed. */
  readonly readable?: readonly string[];
};

let checked: { problem: string | undefined } | undefined;

/** Why programs can't run in a sandbox here, if they can't; checked once. */
export function sandboxProblem(): string | undefined {
  checked ??= {
    problem: !onPath("bwrap")
      ? "This server has no bubblewrap (bwrap), which MCP servers' programs run in. Install bubblewrap."
      : spawnSync(
            "bwrap",
            ["--ro-bind", "/", "/", "--proc", "/proc", "--unshare-all", "--share-net", "true"],
            { stdio: "ignore", timeout: 5_000 },
          ).status !== 0
        ? "bubblewrap can't make a sandbox on this server for MCP servers' programs: it needs user namespaces, which this system or container doesn't allow. In Docker, add the security_opt lines from Nudge's compose.yaml; otherwise allow them."
        : undefined,
  };
  return checked.problem;
}

/** bubblewrap's arguments to run `command` sandboxed; throws when there is no sandbox here. */
export function sandboxed(
  command: string,
  args: readonly string[],
  sandbox: Sandbox,
): { command: string; args: string[] } {
  const problem = sandboxProblem();
  if (problem !== undefined) throw new Error(problem);
  if (sandbox.home !== undefined) mkdirSync(sandbox.home, { recursive: true, mode: 0o700 });
  const system = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];
  // Fonts' caches, and where /etc/resolv.conf points on systemd hosts.
  const extra = ["/var/cache/fontconfig", "/run/systemd/resolve", ...(sandbox.readable ?? [])];
  const writable = [sandbox.cwd, sandbox.home].filter((path) => path !== undefined);
  return {
    command: "bwrap",
    args: [
      "--die-with-parent",
      // No TIOCSTI into Nudge's terminal.
      "--new-session",
      "--unshare-all",
      "--share-net",
      "--hostname",
      "nudge",
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
      ...writable.flatMap((path) => ["--bind", path, path]),
      "--chdir",
      sandbox.cwd ?? sandbox.home ?? "/tmp",
      "--",
      command,
      ...args,
    ],
  };
}

function onPath(program: string): boolean {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((dir) => existsSync(`${dir}/${program}`));
}
