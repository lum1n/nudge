import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installed, runSandboxed, sandboxProblem, type SandboxOptions } from "../src/sandbox.ts";

describe("installed", () => {
  it("finds the programs on the sandbox's PATH, and only those", () => {
    expect(installed(["no-such-program-here", "sh"])).toEqual(["sh"]);
  });
});

// Needs bubblewrap and user namespaces; GitHub's Ubuntu runners, for one, don't allow them.
describe.skipIf(sandboxProblem() !== undefined)("runSandboxed", () => {
  const root = mkdtempSync(join(tmpdir(), "nudge-terminal-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const options = (extra: Partial<SandboxOptions> = {}): SandboxOptions => ({
    workspace: join(root, "workspace"),
    network: false,
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
    const shared = await runSandboxed(interfaces, options({ network: true }));
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
});
