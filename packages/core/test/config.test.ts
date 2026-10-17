import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, ConfigMissing, formatHour, loadConfig, parseConfig } from "../src/index.ts";

describe("parseConfig", () => {
  it("resolves database paths against the config directory", () => {
    const config = parseConfig(
      { assistants: [{ name: "home" }, { name: "work", database: "w.sqlite" }] },
      "/srv/nudge",
    );
    expect(config.assistants.map((a) => a.database)).toEqual([
      "/srv/nudge/data/home.sqlite",
      "/srv/nudge/w.sqlite",
    ]);
  });

  it("rejects bad names and duplicates", () => {
    expect(() => parseConfig({ assistants: [{ name: "Home Base" }] }, "/")).toThrow(ConfigError);
    expect(() => parseConfig({ assistants: [{ name: "a" }, { name: "a" }] }, "/")).toThrow(/twice/);
  });

  it("accepts a server with no assistants yet", () => {
    expect(parseConfig({ assistants: [] }, "/").assistants).toEqual([]);
  });

  it("says where to start when there is no config", async () => {
    await expect(loadConfig("/nowhere/nudge.json")).rejects.toBeInstanceOf(ConfigMissing);
  });

  it("accepts nudge.example.json", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const example = JSON.parse(await readFile(`${root}nudge.example.json`, "utf8"));
    const config = parseConfig(example, root);
    expect(config.assistants.map((a) => a.name)).toEqual(["robin", "pocket"]);
    expect(config.assistants[0]!.extensions?.[0]?.from).toMatch(/extensions\/hello\//);
  });
});

describe("formatHour", () => {
  it("rounds down to the hour so the prompt stays cacheable", () => {
    const at = Date.UTC(2026, 9, 13, 9, 47, 12);
    expect(formatHour(at, "Europe/Oslo")).toBe(
      formatHour(Date.UTC(2026, 9, 13, 9, 0, 0), "Europe/Oslo"),
    );
    expect(formatHour(at, "Europe/Oslo")).toContain("11:00");
  });
});
