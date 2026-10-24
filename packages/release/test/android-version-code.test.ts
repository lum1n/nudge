import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "android-version-code.sh");

const code = (version: string) => {
  const run = spawnSync("sh", [SCRIPT, version], { encoding: "utf8" });
  return run.status === 0 ? Number(run.stdout.trim()) : undefined;
};

describe("android-version-code.sh", () => {
  it("numbers releases and pre-releases so each is above the one before", () => {
    const order = [
      "0.9.0-beta",
      "0.9.0-beta.1",
      "0.9.0-rc.2",
      "0.9.0",
      "0.9.1",
      "0.10.0-beta.1",
      "0.10.0",
      "1.0.0",
    ].map(code);
    expect(order).toEqual([90000, 90001, 90002, 90099, 90199, 100001, 100099, 1000099]);
  });

  it("reads leading zeros as decimal and caps a pre-release below its release", () => {
    expect(code("0.08.0-beta.09")).toBe(80009);
    expect(code("1.2.3-rc.150")).toBe(1020398);
  });

  it("refuses what isn't major.minor.patch, or doesn't fit", () => {
    for (const version of ["2.0", "1.x.0", "0.1.0.1", "0.100.0", "v1.0.0", ""]) {
      expect(code(version), version).toBeUndefined();
    }
  });
});
