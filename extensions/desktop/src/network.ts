// The network of a desktop's sandboxed apps: the internet through slirp4netns, without this
// machine's own services (such as signal-cli's daemon on 127.0.0.1) or the local network. One
// network namespace per desktop, held open by a process of its own; every app joins it.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Addresses the apps never reach: this machine (slirp4netns's 10.0.2.2), the local network,
 * link-local (cloud metadata), CGNAT (Tailscale) and the rest of the private and reserved ranges,
 * as for the terminal's commands. slirp4netns's own network, 10.0.2.0/24, is more specific than
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

/** slirp4netns's DNS, for the apps' /etc/resolv.conf. */
export const RESOLV_CONF = "nameserver 10.0.2.3\n";

let checked: { problem: string | undefined } | undefined;

/** Why the apps can't have the internet without this machine and the local network here; checked once. */
export function networkProblem(): string | undefined {
  checked ??= {
    problem: ["slirp4netns", "unshare", "nsenter", "ip"].some((program) => !onPath(program))
      ? `The desktop's sandboxed apps reach the internet, without this machine and the local network, through slirp4netns, which needs slirp4netns, unshare and nsenter (util-linux) and ip (iproute2) on this server. Install them, or turn the desktop extension's "localNetwork" setting on to let the apps reach what the server reaches.`
      : !existsSync("/dev/net/tun")
        ? `The desktop's sandboxed apps reach the internet through slirp4netns, which needs /dev/net/tun, and this server or container doesn't have it. In Docker, add the devices line from Nudge's compose.yaml; or turn the desktop extension's "localNetwork" setting on.`
        : undefined,
  };
  return checked.problem;
}

/** A desktop's network namespace, and the processes that keep it: they go with the desktop. */
export interface AppNetwork {
  /** A process in the namespace, for apps to join. */
  pid: number;
  holder: ChildProcess;
  slirp: ChildProcess;
}

/**
 * Makes a network namespace with the internet: a user namespace of its own, where this user is
 * root, holds it; slirp4netns gives it a network that goes out through this machine's, without
 * reaching this machine's own services, and `ip` blocks the private and reserved ranges in it.
 * Both processes end when this one does: the holder at the end of its input, slirp4netns with its
 * exit fd.
 */
export async function openAppNetwork(): Promise<AppNetwork> {
  const problem = networkProblem();
  if (problem) throw new Error(problem);
  // Says it's there, waits for slirp4netns, blocks the ranges, says so and waits for its end.
  const script = `echo
read -r _ || exit 1
ip link set lo up || exit 1
for range; do ip route add prohibit "$range" || exit 1; done
echo
exec cat >/dev/null`;
  const holder = spawn(
    "unshare",
    ["--user", "--map-root-user", "--net", "--", "sh", "-c", script, "sh", ...BLOCKED],
    { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { PATH: process.env.PATH ?? "" } },
  );
  holder.stdin!.on("error", () => {});
  let slirp: ChildProcess | undefined;
  try {
    const lines = linesOf(holder);
    await lines.next();
    const pid = holder.pid!;
    slirp = spawn(
      "slirp4netns",
      [
        "--configure",
        "--mtu=65520",
        "--disable-host-loopback",
        "--ready-fd=3",
        "--exit-fd=4",
        String(pid),
        "tap0",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true },
    );
    for (const fd of [3, 4]) (slirp.stdio[fd] as NodeJS.EventEmitter).on("error", () => {});
    await slirpReady(slirp);
    holder.stdin!.write("\n");
    await lines.next();
    return { pid, holder, slirp };
  } catch (error) {
    for (const child of [holder, slirp]) child?.kill("SIGKILL");
    throw new Error(`The desktop's apps got no network: ${(error as Error).message}`);
  }
}

/** The command that runs `command` in the network's namespace, as root of its user namespace. */
export function inAppNetwork(network: AppNetwork, command: readonly string[]): string[] {
  return [
    "nsenter",
    "--target",
    String(network.pid),
    "--user",
    "--net",
    "--preserve-credentials",
    ...command,
  ];
}

/**
 * Where /etc/resolv.conf's text is, for slirp4netns's DNS to take its place: bubblewrap can't mount
 * on a link, and on systemd hosts it links to /run/systemd/resolve.
 */
export function resolvConf(): string {
  let path = "/etc/resolv.conf";
  for (let links = 0; links < 10; links++) {
    try {
      if (!lstatSync(path).isSymbolicLink()) break;
    } catch {
      break;
    }
    path = resolve(dirname(path), readlinkSync(path));
  }
  return path;
}

/** The lines the holder says, one by one; rejects with what it said on stderr if it ends first. */
function linesOf(holder: ChildProcess): { next(): Promise<void> } {
  let errors = "";
  let seen = 0;
  let waiting: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let ended: Error | undefined;
  holder.stderr!.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  holder.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    seen += chunk.split("\n").length - 1;
    if (seen > 0 && waiting) {
      seen--;
      waiting.resolve();
      waiting = undefined;
    }
  });
  const end = (error: Error) => {
    ended = error;
    waiting?.reject(error);
    waiting = undefined;
  };
  holder.once("error", end);
  holder.once("exit", () => end(new Error(errors.trim() || "its namespace ended")));
  return {
    next: () =>
      new Promise<void>((resolve, reject) => {
        if (seen > 0) {
          seen--;
          return resolve();
        }
        if (ended) return reject(ended);
        const timer = setTimeout(() => reject(new Error("its namespace didn't start")), 5_000);
        waiting = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
      }),
  };
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

function onPath(program: string): boolean {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((dir) => existsSync(`${dir}/${program}`));
}
