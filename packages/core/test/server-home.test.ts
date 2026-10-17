import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfigPath, serverHome } from "../src/index.ts";

describe("the server's data directory", () => {
  it("is NUDGE_HOME, else the platform's place for application data", () => {
    expect(serverHome({ NUDGE_HOME: "/data" }, "linux", "/home/ann")).toBe("/data");
    expect(serverHome({}, "linux", "/home/ann")).toBe("/home/ann/.local/share/nudge");
    expect(serverHome({ XDG_DATA_HOME: "/xdg" }, "linux", "/home/ann")).toBe("/xdg/nudge");
    expect(serverHome({}, "darwin", "/Users/ann")).toBe(
      "/Users/ann/Library/Application Support/Nudge",
    );
  });

  describe("the config a command uses", () => {
    let cwd: string;
    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), "nudge-home-"));
    });
    afterEach(() => rm(cwd, { recursive: true, force: true }));

    it("is the data directory's, unless the working directory has one", async () => {
      expect(defaultConfigPath({}, cwd, "linux", "/home/ann")).toBe(
        "/home/ann/.local/share/nudge/nudge.json",
      );
      await writeFile(join(cwd, "nudge.json"), "{}");
      expect(defaultConfigPath({}, cwd, "linux", "/home/ann")).toBe(join(cwd, "nudge.json"));
    });

    it("is always NUDGE_HOME's when that is set", async () => {
      await writeFile(join(cwd, "nudge.json"), "{}");
      expect(defaultConfigPath({ NUDGE_HOME: "/data" }, cwd)).toBe("/data/nudge.json");
    });
  });
});
