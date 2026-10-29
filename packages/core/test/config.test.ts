import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ConfigMissing,
  formatToday,
  loadConfig,
  parseConfig,
  renderInstructions,
} from "../src/index.ts";

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

describe("instructions", () => {
  it("takes text or key/value pairs and renders pairs as a line each", () => {
    const config = parseConfig(
      {
        assistants: [
          { name: "a", instructions: "Be brief." },
          { name: "b", instructions: { approach: "Look it up first.", tools: "Use search." } },
        ],
      },
      "/",
    );
    const [a, b] = config.assistants;
    expect(renderInstructions(a?.instructions ?? "")).toBe("Be brief.");
    expect(renderInstructions(b?.instructions ?? "")).toBe(
      "approach: Look it up first.\ntools: Use search.",
    );
  });

  it("refuses pairs whose values are not text", () => {
    expect(() =>
      parseConfig({ assistants: [{ name: "a", instructions: { tools: 3 } }] }, "/"),
    ).toThrow(ConfigError);
  });
});

describe("formatToday", () => {
  it("changes only with the day so the prompt stays cacheable", () => {
    const morning = Date.UTC(2026, 9, 13, 7, 5, 0);
    const evening = Date.UTC(2026, 9, 13, 21, 47, 12);
    expect(formatToday(morning, "Europe/Oslo")).toBe(formatToday(evening, "Europe/Oslo"));
    expect(formatToday(morning, "Europe/Oslo")).toContain("Tuesday, 13 October 2026");
    // Past midnight in Oslo, still the 13th in UTC.
    expect(formatToday(Date.UTC(2026, 9, 13, 22, 30, 0), "Europe/Oslo")).toContain("14 October");
  });
});
