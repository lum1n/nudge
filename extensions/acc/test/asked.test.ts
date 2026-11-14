import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Asked } from "../src/asked.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("what approvals asked", () => {
  it("hands a request back once, then forgets it", () => {
    const asked = new Asked<string>(undefined);
    asked.set("lobby", "a1", "run ls");
    expect(asked.take("lobby", "a1")).toBe("run ls");
    expect(asked.take("lobby", "a1")).toBeUndefined();
  });

  it("forgets only the deleted room's requests, and keeps that across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-asked-"));
    dirs.push(dir);
    const file = join(dir, "sub", "asked.json");
    const asked = new Asked<string>(file);
    asked.set("r1", "a1", "one");
    asked.set("r1", "a2", "two");
    asked.set("r10", "a1", "ten");
    asked.set("r2", "a1", "other");

    asked.forgetRoom("r1");

    expect(asked.take("r1", "a1")).toBeUndefined();
    expect(asked.take("r1", "a2")).toBeUndefined();
    const again = new Asked<string>(file);
    expect(again.take("r10", "a1")).toBe("ten");
    expect(again.take("r2", "a1")).toBe("other");
  });

  it("writes nothing when the room asked nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-asked-"));
    dirs.push(dir);
    const file = join(dir, "asked.json");
    const asked = new Asked<string>(file);
    asked.set("r2", "a1", "other");
    const before = readFileSync(file, "utf8");
    asked.forgetRoom("r1");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
