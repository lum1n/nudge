import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, listExtensionSetups, saveExtensionSetups } from "../src/index.ts";

let dir: string;
let config: string;

/** A package in `extensions/<name>` exporting a Nudge extension with a plain JSON Schema. */
async function addPackage(name: string, settings?: unknown): Promise<void> {
  const root = join(dir, "extensions", name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: `ext-${name}`, type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(root, "index.js"),
    `export default ${JSON.stringify({
      kind: "nudge.extension",
      name,
      version: "1.0.0",
      description: `The ${name} one`,
      ...(settings === undefined ? {} : { settings }),
    }).replace(/}$/, ", setup: () => ({}) }")};\n`,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-settings-"));
  config = join(dir, "nudge.json");
  await addPackage("bot", {
    type: "object",
    properties: {
      token: { type: "string", default: "${BOT_TOKEN}" },
      pollSeconds: { type: "number", default: 30 },
    },
    required: ["token", "pollSeconds"],
  });
  await addPackage("lists");
  await writeFile(
    config,
    JSON.stringify({
      $comment: "top",
      assistants: [
        {
          name: "home",
          extensions: [
            {
              $comment: "the bot",
              from: "./extensions/bot",
              settings: { $comment: "s", pollSeconds: 5 },
            },
          ],
        },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listExtensionSetups", () => {
  it("lists configured extensions, then ones found beside the config", async () => {
    const setups = await listExtensionSetups(config, "home", {});
    expect(setups.map((s) => [s.from, s.name, s.configured, s.enabled])).toEqual([
      ["./extensions/bot", "bot", true, true],
      ["./extensions/lists", "lists", false, false],
    ]);
    expect(setups[0]!.settings).toEqual({ pollSeconds: 5 });
    expect(setups[0]!.schema).toMatchObject({ properties: { token: { type: "string" } } });
    expect(setups[0]!.missingEnv).toEqual(["BOT_TOKEN"]);
    expect((await listExtensionSetups(config, "home", { BOT_TOKEN: "x" }))[0]!.missingEnv).toEqual(
      [],
    );
  });

  it("names a module that does not load instead of failing", async () => {
    await writeFile(join(dir, "extensions", "lists", "index.js"), "throw new Error('broken');");
    const [, lists] = await listExtensionSetups(config, "home", {});
    expect(lists!.name).toBeUndefined();
    expect(lists!.error).toMatch(/broken/);
  });
});

describe("saveExtensionSetups", () => {
  it("writes the choices after apply, keeping comments", async () => {
    let applied: unknown;
    await saveExtensionSetups(
      config,
      "home",
      [
        { from: "./extensions/lists", enabled: true, rooms: ["shared"] },
        { from: "./extensions/bot", enabled: false, settings: { pollSeconds: 10 } },
      ],
      async (next) => {
        applied = next.assistants[0]!.extensions!.map((e) => e.enabled);
      },
    );
    expect(applied).toEqual([undefined, false]);
    const written = JSON.parse(await readFile(config, "utf8"));
    expect(written.$comment).toBe("top");
    expect(written.assistants[0].extensions).toEqual([
      { from: "./extensions/lists", rooms: ["shared"] },
      {
        $comment: "the bot",
        from: "./extensions/bot",
        settings: { $comment: "s", pollSeconds: 10 },
        enabled: false,
      },
    ]);
  });

  it("leaves the file alone when apply throws", async () => {
    const before = await readFile(config, "utf8");
    await expect(
      saveExtensionSetups(config, "home", [], async () => {
        throw new Error("reload failed");
      }),
    ).rejects.toThrow("reload failed");
    expect(await readFile(config, "utf8")).toBe(before);
  });

  it("refuses extensions from anywhere else", async () => {
    await expect(
      saveExtensionSetups(
        config,
        "home",
        [{ from: "/tmp/evil.js", enabled: true }],
        async () => {},
      ),
    ).rejects.toThrow(ConfigError);
    await expect(saveExtensionSetups(config, "nobody", [], async () => {})).rejects.toThrow(
      /No assistant/,
    );
  });
});
