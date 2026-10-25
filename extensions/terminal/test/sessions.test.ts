import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEEP, MAX_KEPT, TerminalLog, type TerminalFrame } from "../src/sessions.ts";

const result = (output: string, exitCode = 0) => ({
  exitCode,
  output,
  cut: 0,
  timedOut: false,
  aborted: false,
  workspaceFull: false,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the terminal's log", () => {
  it("keeps commands across a restart, and what ran then as stopped", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-terminal-log-"));
    dirs.push(dir);
    const log = new TerminalLog(dir, () => 1);
    const done = log.start(7, { command: "ls" });
    log.finish(7, done.id, result("a\n"));
    log.start(7, { command: "sleep 100" });

    const again = new TerminalLog(dir, () => 2);
    expect(again.commands(7, "ann")).toMatchObject([
      { id: "c1", status: "done", output: "a\n" },
      { id: "c2", status: "stopped", ending: "the server restarted" },
    ]);
    expect(again.start(7, { command: "pwd" }).id).toBe("c3");
  });

  it("shows a private command only to whom it is private to", () => {
    const log = new TerminalLog(undefined, () => 1);
    const ann: TerminalFrame[] = [];
    const bob: TerminalFrame[] = [];
    log.watch(1, "ann", (frame) => ann.push(frame));
    log.watch(1, "bob", (frame) => bob.push(frame));
    const entry = log.start(1, { command: "cat secret", privateTo: "ann" });
    log.output(1, entry.id, "hush");

    expect(log.commands(1, "ann")).toHaveLength(1);
    expect(log.commands(1, "bob")).toHaveLength(0);
    expect(ann).toContainEqual({ type: "output", id: entry.id, chunk: "hush" });
    expect(bob.some((frame) => frame.type === "output")).toBe(false);
  });

  it("keeps the newest commands, and the end of long output", () => {
    const log = new TerminalLog(undefined, () => 1);
    for (let i = 0; i < KEEP + 5; i++) log.start(1, { command: `echo ${i}` });
    const commands = log.commands(1, "ann");
    expect(commands).toHaveLength(KEEP);
    expect(commands[0]!.command).toBe("echo 5");

    const long = commands.at(-1)!;
    log.output(1, long.id, "x".repeat(MAX_KEPT) + "end");
    expect(log.commands(1, "ann").at(-1)!.output).toHaveLength(MAX_KEPT);
    expect(log.commands(1, "ann").at(-1)!.output.endsWith("end")).toBe(true);
  });
});
