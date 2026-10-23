import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepDesktops } from "../src/session.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe.runIf(process.platform === "linux")("sweepDesktops", () => {
  it("stops what a desktop of a process that is gone left running, and leaves live ones alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "nudge-sweep-test-"));
    dirs.push(root);
    // A pid that has been and gone, as a killed Nudge's.
    const dead = spawnSync("true").pid!;
    const left = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const orphan = join(root, "nudge-desktop-orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "owner"), `${dead}\n`);
    // The second group's leader runs something else now: a recycled pid, not ours to stop.
    writeFileSync(join(orphan, "groups"), `${left.pid} sleep\n${stranger.pid} Xvfb\n`);
    // From before owners were noted: old ones go, new ones may be starting.
    const ancient = join(root, "nudge-desktop-ancient");
    mkdirSync(ancient);
    utimesSync(ancient, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));
    const starting = join(root, "nudge-desktop-starting");
    mkdirSync(starting);
    const live = join(root, "nudge-desktop-live");
    mkdirSync(live);
    writeFileSync(join(live, "owner"), `${process.pid}\n`);
    try {
      expect(sweepDesktops(root)).toBe(2);
      for (let i = 0; i < 50 && !gone(left.pid!); i++) await new Promise((r) => setTimeout(r, 20));
      expect(gone(left.pid!)).toBe(true);
      expect(gone(stranger.pid!)).toBe(false);
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(ancient)).toBe(false);
      expect(existsSync(starting)).toBe(true);
    } finally {
      left.kill();
      stranger.kill();
    }
  });
});
