import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inAppNetwork, openAppNetwork } from "../src/network.ts";
import { sandboxProblem } from "../src/session.ts";

const onPath = (program: string) =>
  (process.env.PATH ?? "").split(":").some((dir) => existsSync(join(dir, program)));

// slirp4netns itself is left out: a stand-in that only says it's ready leaves the network bare,
// which is enough to see the blocks the desktop sets up around it, and that apps can't lift them.
describe.skipIf(
  process.platform !== "linux" ||
    sandboxProblem() !== undefined ||
    !existsSync("/dev/net/tun") ||
    ["unshare", "nsenter", "ip", "bash"].some((program) => !onPath(program)),
)("openAppNetwork", () => {
  const root = mkdtempSync(join(tmpdir(), "nudge-desktop-net-"));
  const path = process.env.PATH;
  beforeAll(() => {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "slirp4netns"), "#!/bin/sh\nprintf 1 >&3\nexec sleep 60\n");
    chmodSync(join(root, "bin", "slirp4netns"), 0o755);
    process.env.PATH = `${join(root, "bin")}:${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  });

  it("blocks this machine and the local network for the sandboxed apps", async () => {
    // A service of this machine's, like signal-cli's daemon.
    const service = createServer((socket) => socket.end("reached\n"));
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const port = (service.address() as { port: number }).port;
    const network = await openAppNetwork();
    try {
      const script = `id -u; ip route; (exec 3<>/dev/tcp/192.168.1.1/80); (exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3); ip route del prohibit 10.0.0.0/8`;
      const [program, ...args] = inAppNetwork(network, [
        "bwrap",
        "--die-with-parent",
        "--unshare-user",
        "--uid",
        String(process.getuid!()),
        "--gid",
        String(process.getgid!()),
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--unshare-pid",
        "--",
        "bash",
        "-c",
        script,
      ]);
      const output = await run(spawn(program!, args, { stdio: ["ignore", "pipe", "pipe"] }));
      // As this user, not root of the namespace.
      expect(output).toMatch(new RegExp(`^${process.getuid!()}$`, "m"));
      expect(output).toMatch(/^prohibit 192\.168\.0\.0\/16/m);
      expect(output).toMatch(/^prohibit 127\.0\.0\.0\/8/m);
      expect(output).toMatch(/^prohibit 10\.0\.2\.2/m);
      expect(output).toMatch(/192\.168\.1\.1\/80: (Permission denied|Network is unreachable)/);
      // Its own loopback, where nothing listens: not this machine's.
      expect(output).toMatch(new RegExp(`127\\.0\\.0\\.1/${port}: Connection refused`));
      expect(output).not.toContain("reached");
      expect(output).toMatch(/Operation not permitted/);
    } finally {
      for (const child of [network.holder, network.slirp]) child.kill("SIGKILL");
      service.close();
    }
  });
});

function run(child: ChildProcess): Promise<string> {
  let output = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve(output));
  });
}
