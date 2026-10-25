import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installed,
  memoryScope,
  readFromSandbox,
  runSandboxed,
  sandboxProblem,
  type SandboxOptions,
  tmpfsSize,
  workspaceBytes,
  writeToSandbox,
} from "../src/sandbox.ts";

describe("installed", () => {
  it("finds the programs on the sandbox's PATH, and only those", () => {
    expect(installed(["no-such-program-here", "sh"])).toEqual(["sh"]);
  });
});

describe("workspaceBytes", () => {
  it("counts what is on disk under a directory, a hard-linked file once", async () => {
    const root = mkdtempSync(join(tmpdir(), "nudge-terminal-size-"));
    try {
      const empty = await workspaceBytes(root);
      mkdirSync(join(root, "sub"));
      writeFileSync(join(root, "sub", "a"), Buffer.alloc(100_000, 1));
      const one = await workspaceBytes(root);
      expect(one - empty).toBeGreaterThanOrEqual(100_000);
      linkSync(join(root, "sub", "a"), join(root, "b"));
      expect(await workspaceBytes(root)).toBe(one);
      expect(await workspaceBytes(join(root, "missing"))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Needs bubblewrap and user namespaces; GitHub's Ubuntu runners, for one, don't allow them.
describe.skipIf(sandboxProblem() !== undefined)("runSandboxed", () => {
  const root = mkdtempSync(join(tmpdir(), "nudge-terminal-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const options = (extra: Partial<SandboxOptions> = {}): SandboxOptions => ({
    workspace: join(root, "workspace"),
    network: "off",
    timeoutMs: 10_000,
    maxOutput: 10_000,
    ...extra,
  });

  it("runs in the workspace, and its files stay", async () => {
    const first = await runSandboxed("pwd && echo hi > note.txt", options());
    expect(first).toMatchObject({ exitCode: 0, timedOut: false });
    expect(first.output.trim()).toBe("/workspace");
    expect(readFileSync(join(root, "workspace", "note.txt"), "utf8")).toBe("hi\n");
    const second = await runSandboxed("cat note.txt; exit 3", options());
    expect(second).toMatchObject({ exitCode: 3, output: "hi\n" });
  });

  it("sees none of the machine's files or Nudge's environment", async () => {
    process.env.NUDGE_TEST_SECRET = "s3cret";
    try {
      const result = await runSandboxed(
        `ls ${homedir()} 2>&1; echo "env:$NUDGE_TEST_SECRET"; ls /tmp | wc -l; touch /usr/x 2>&1`,
        options(),
      );
      expect(result.output).toMatch(/No such file or directory/);
      expect(result.output).toContain("env:\n");
      expect(result.output).not.toContain("s3cret");
      expect(result.output).toMatch(/^0$/m);
      expect(result.output).toMatch(/Read-only file system|Permission denied/);
    } finally {
      delete process.env.NUDGE_TEST_SECRET;
    }
  });

  it("has no network unless given it", async () => {
    const interfaces = "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '";
    expect((await runSandboxed(interfaces, options())).output.trim()).toBe("lo");
    const shared = await runSandboxed(interfaces, options({ network: "all" }));
    expect(shared.output.trim()).not.toBe("lo");
  });

  it("stops a command that runs too long, with everything it started", async () => {
    const started = Date.now();
    const result = await runSandboxed(
      "sleep 30 & sleep 30; echo never",
      options({ timeoutMs: 500 }),
    );
    expect(result).toMatchObject({ timedOut: true, exitCode: undefined });
    expect(result.output).not.toContain("never");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps the start and the end of long output", async () => {
    const result = await runSandboxed("seq 1 100000", options({ maxOutput: 1_000 }));
    expect(result.cut).toBeGreaterThan(0);
    expect(result.output.startsWith("1\n2\n")).toBe(true);
    expect(result.output.trimEnd().endsWith("100000")).toBe(true);
    expect(result.output.length).toBeLessThan(1_100);
  });

  it("refuses a working directory outside the workspace", async () => {
    await expect(runSandboxed("ls", options({ cwd: "../etc" }))).rejects.toThrow(/has to be in/);
    expect(existsSync(join(root, "workspace"))).toBe(true);
  });

  it("moves files in and out within what commands see", async () => {
    const workspace = join(root, "files");
    expect(await writeToSandbox("in/report.txt", Buffer.from("hei"), { workspace })).toBe(
      "/workspace/in/report.txt",
    );
    expect(readFileSync(join(workspace, "in", "report.txt"), "utf8")).toBe("hei");
    await expect(writeToSandbox("in/report.txt", Buffer.from("x"), { workspace })).rejects.toThrow(
      /cannot overwrite/,
    );
    expect(String(await readFromSandbox("in/report.txt", { workspace }, 100))).toBe("hei");
    await expect(readFromSandbox("in/report.txt", { workspace }, 2)).rejects.toThrow(/over the 2/);
    await expect(readFromSandbox("missing", { workspace }, 100)).rejects.toThrow(/not a file/);
    // A link to the machine's files leads only to the sandbox's.
    await runSandboxed(`ln -s ${homedir()}/.bashrc link`, options({ workspace }));
    await expect(readFromSandbox("link", { workspace }, 1_000_000)).rejects.toThrow(/not a file/);
  });

  it("stops a command that uses more memory than it may", async () => {
    // Random text, as what compresses well is cheap in zswap: a string of 200 MB in bash, against
    // 100 MB. The cgroup stops it, or allocating fails.
    const big = "s=$(head -c 150000000 /dev/urandom | base64 -w0); echo survived ${#s}";
    const result = await runSandboxed(big, options({ maxMemoryBytes: 100 * 1024 ** 2 }));
    expect(result.output).not.toMatch(/^survived/m);
    expect(result.exitCode).not.toBe(0);
    const small = await runSandboxed(
      "s=$(head -c 10000000 /dev/zero | tr '\\0' x); echo survived ${#s}",
      options({ maxMemoryBytes: 100 * 1024 ** 2 }),
    );
    expect(small).toMatchObject({ exitCode: 0, output: "survived 10000000\n" });
  });

  it.skipIf(!memoryScope())("caps the memory of all a command starts together", async () => {
    // Two programs of 70 MB each fit a cap of 100 MB on their own, not together.
    const hold = "s=$(head -c 52500000 /dev/urandom | base64 -w0); sleep 2; echo held ${#s}";
    const result = await runSandboxed(
      `(${hold}) & (${hold}) & wait`,
      options({ maxMemoryBytes: 100 * 1024 ** 2 }),
    );
    expect(result.output.match(/^held \d+$/gm)?.length ?? 0).toBeLessThan(2);
  });

  it.skipIf(!tmpfsSize())("keeps /tmp within the memory a command may use", async () => {
    // /tmp is full at 20 MB, or the cgroup stops what fills it.
    const result = await runSandboxed(
      "head -c 50000000 /dev/zero > /tmp/x; echo size $(stat -c %s /tmp/x)",
      options({ maxMemoryBytes: 20 * 1024 ** 2 }),
    );
    expect(result.output).not.toContain("size 50000000");
  });

  it("stops a command that fills the workspace, but lets a full one be cleared", async () => {
    const workspace = join(root, "quota");
    const started = Date.now();
    const result = await runSandboxed(
      "head -c 3000000 /dev/zero > big; sleep 8; echo never",
      options({ workspace, maxWorkspaceBytes: 1024 ** 2 }),
    );
    expect(result).toMatchObject({ workspaceFull: true, exitCode: undefined, timedOut: false });
    expect(result.output).not.toContain("never");
    expect(Date.now() - started).toBeLessThan(6_000);
    // Over already: no file comes in, but commands still run to clear it up.
    await expect(
      writeToSandbox("in.txt", Buffer.from("x"), { workspace, maxWorkspaceBytes: 1024 ** 2 }),
    ).rejects.toThrow(/over the 1 MB allowed/);
    const cleared = await runSandboxed(
      "rm big && echo cleared",
      options({ workspace, maxWorkspaceBytes: 1024 ** 2 }),
    );
    expect(cleared).toMatchObject({ exitCode: 0, workspaceFull: false, output: "cleared\n" });
    expect(
      await writeToSandbox("in.txt", Buffer.from("x"), { workspace, maxWorkspaceBytes: 1024 ** 2 }),
    ).toBe("/workspace/in.txt");
  }, 15_000);

  it("shares the room's desktop's home when given it", async () => {
    const desktop = join(root, "desktop-home");
    mkdirSync(desktop);
    writeFileSync(join(desktop, "letter.odt"), "odt");
    const shared = await runSandboxed(
      "cat /desktop/letter.odt && touch /desktop/out.md",
      options({ desktop }),
    );
    expect(shared).toMatchObject({ exitCode: 0, output: "odt" });
    expect(existsSync(join(desktop, "out.md"))).toBe(true);
    // Not there before the desktop has made it.
    const missing = await runSandboxed("ls /desktop", options({ desktop: join(root, "none") }));
    expect(missing.exitCode).not.toBe(0);
  });
});

/** Whether a program is on this machine's PATH. */
const onPath = (program: string) =>
  (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, program)));

// slirp4netns itself is left out: a stand-in that only says it's ready leaves the network bare,
// which is enough to see the blocks and DNS that the terminal sets up around it.
describe.skipIf(
  sandboxProblem() !== undefined ||
    ["nsenter", "ip"].some((program) =>
      (process.env.PATH ?? "").split(":").every((dir) => !existsSync(join(dir, program))),
    ) ||
    !existsSync("/dev/net/tun"),
)("runSandboxed with the internet", () => {
  const root = mkdtempSync(join(tmpdir(), "nudge-terminal-net-"));
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

  it("blocks this machine and the local network, and uses slirp4netns's DNS", async () => {
    const result = await runSandboxed(
      "ip route; cat /etc/resolv.conf; (exec 3<>/dev/tcp/192.168.1.1/80); (exec 3<>/dev/tcp/10.0.2.2/80); id -u; ip route del prohibit 10.0.0.0/8",
      {
        workspace: join(root, "workspace"),
        network: "internet",
        timeoutMs: 10_000,
        maxOutput: 10_000,
      },
    );
    expect(result.output).toMatch(/^prohibit 192\.168\.0\.0\/16/m);
    expect(result.output).toMatch(/^prohibit 10\.0\.2\.2/m);
    expect(result.output).toContain("nameserver 10.0.2.3");
    expect(result.output).toMatch(/192\.168\.1\.1\/80: Permission denied/);
    expect(result.output).toMatch(/10\.0\.2\.2\/80: Permission denied/);
    // Root of its own namespace, without the capabilities to lift the blocks.
    expect(result.output).toMatch(/^0$/m);
    expect(result.output).toMatch(/Operation not permitted/);
  });
});

// With the real slirp4netns, where this machine has it and /dev/net/tun: the internet and its DNS
// work, and a service of this machine's is out of reach, at 10.0.2.2, 127.0.0.1 or its own
// addresses on the local network. networkProblem() isn't asked: it is checked once, and the stand-in
// above changes what it would find.
describe.skipIf(
  sandboxProblem() !== undefined ||
    !["slirp4netns", "nsenter", "ip"].every(onPath) ||
    !existsSync("/dev/net/tun"),
)("runSandboxed with slirp4netns", () => {
  const root = mkdtempSync(join(tmpdir(), "nudge-terminal-slirp-"));
  const server = createServer((_request, response) => response.end("reached"));
  beforeAll(() => new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve)));
  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reaches the internet but not this machine", async () => {
    const port = (server.address() as AddressInfo).port;
    const own = Object.values(networkInterfaces())
      .flat()
      .filter((address) => address?.family === "IPv4" && !address.internal)
      .map((address) => address!.address);
    const hosts = ["10.0.2.2", "127.0.0.1", ...own];
    const result = await runSandboxed(
      [
        "getent ahostsv4 example.com >/dev/null && echo resolved",
        "(exec 3<>/dev/tcp/example.com/80) && echo connected",
        ...hosts.map((host) => `(exec 3<>/dev/tcp/${host}/${port}) || echo blocked ${host}`),
      ].join("\n"),
      {
        workspace: join(root, "workspace"),
        network: "internet",
        timeoutMs: 30_000,
        maxOutput: 10_000,
      },
    );
    expect(result.output).toMatch(/^resolved$/m);
    expect(result.output).toMatch(/^connected$/m);
    for (const host of hosts) expect(result.output).toContain(`blocked ${host}`);
  });
});
