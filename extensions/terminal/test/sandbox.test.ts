import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readFromSandbox,
  runSandboxed,
  sandboxProblem,
  type SandboxOptions,
  writeToSandbox,
} from "../src/sandbox.ts";

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

// slirp4netns itself is left out: a stand-in that only says it's ready leaves the network bare,
// which is enough to see the blocks and DNS that the terminal sets up around it.
describe.skipIf(
  sandboxProblem() !== undefined ||
    ["nsenter", "ip"].some((program) =>
      (process.env.PATH ?? "").split(":").every((dir) => !existsSync(join(dir, program))),
    ),
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
