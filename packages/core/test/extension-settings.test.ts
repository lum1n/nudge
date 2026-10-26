import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  listExtensionSetups,
  loadConfig,
  saveExtensionSetups,
  sealConfigSecrets,
} from "../src/index.ts";

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
    const setups = await listExtensionSetups(config, "home", {}, []);
    expect(setups.map((s) => [s.from, s.name, s.configured, s.enabled])).toEqual([
      ["./extensions/bot", "bot", true, true],
      ["./extensions/lists", "lists", false, false],
    ]);
    expect(setups[0]!.settings).toEqual({ pollSeconds: 5 });
    expect(setups[0]!.schema).toMatchObject({ properties: { token: { type: "string" } } });
    expect(setups[0]!.missingEnv).toEqual(["BOT_TOKEN"]);
    expect(
      (await listExtensionSetups(config, "home", { BOT_TOKEN: "x" }, []))[0]!.missingEnv,
    ).toEqual([]);
  });

  it("names a module that does not load instead of failing", async () => {
    await writeFile(join(dir, "extensions", "lists", "index.js"), "throw new Error('broken');");
    const [, lists] = await listExtensionSetups(config, "home", {}, []);
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

describe("secrets in settings", () => {
  beforeEach(async () => {
    await addPackage("mail", {
      type: "object",
      properties: {
        accounts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              user: { type: "string" },
              imap: {
                allOf: [
                  { type: "object", properties: { password: { type: "string", writeOnly: true } } },
                ],
              },
            },
          },
        },
      },
    });
  });

  const account = (password: string) => ({
    accounts: [{ user: "ann", imap: { password } }],
  });
  const stored = async () =>
    JSON.parse(await readFile(config, "utf8")).assistants[0].extensions[0].settings.accounts[0];

  it("keeps a password saved from the settings page out of nudge.json, and opens it on load", async () => {
    await saveExtensionSetups(
      config,
      "home",
      [{ from: "./extensions/mail", enabled: true, settings: account("hunter2") }],
      async (parsed) => {
        expect(parsed.assistants[0]!.extensions![0]!.settings).toEqual(account("hunter2"));
      },
    );
    const text = await readFile(config, "utf8");
    expect(text).not.toContain("hunter2");
    expect((await stored()).imap.password).toMatch(/^\$\{secret:[\w-]+\}$/);
    expect((await stored()).user).toBe("ann");
    const loaded = await loadConfig(config);
    expect(loaded.assistants[0]!.extensions![0]!.settings).toEqual(account("hunter2"));
    expect(
      await readFile(join(dir, "server", "settings-secrets", "secrets.enc"), "utf8"),
    ).not.toContain("hunter2");
  });

  it("keeps a stored password the page sends back, and drops one replaced", async () => {
    const save = (settings: unknown) =>
      saveExtensionSetups(
        config,
        "home",
        [
          {
            from: "./extensions/mail",
            enabled: true,
            settings: settings as Record<string, unknown>,
          },
        ],
        async () => {},
      );
    await save(account("first"));
    const reference = (await stored()).imap.password;
    await save(account(reference));
    expect((await stored()).imap.password).toBe(reference);
    await save(account("second"));
    expect((await stored()).imap.password).not.toBe(reference);
    const loaded = await loadConfig(config);
    expect(loaded.assistants[0]!.extensions![0]!.settings).toEqual(account("second"));
  });

  it("leaves ${NAME} values in the file", async () => {
    await saveExtensionSetups(
      config,
      "home",
      [{ from: "./extensions/mail", enabled: true, settings: account("${MAIL_PASSWORD}") }],
      async () => {},
    );
    expect((await stored()).imap.password).toBe("${MAIL_PASSWORD}");
  });

  it("moves passwords an older config has as plain text", async () => {
    await writeFile(
      config,
      JSON.stringify({
        assistants: [
          {
            name: "home",
            extensions: [{ from: "./extensions/mail", settings: account("hunter2") }],
          },
        ],
      }),
    );
    expect(await sealConfigSecrets(config)).toBe(true);
    expect(await readFile(config, "utf8")).not.toContain("hunter2");
    const loaded = await loadConfig(config);
    expect(loaded.assistants[0]!.extensions![0]!.settings).toEqual(account("hunter2"));
    expect(await sealConfigSecrets(config)).toBe(false);
  });

  it("says which setting to set again when its secret is gone", async () => {
    await writeFile(
      config,
      JSON.stringify({
        assistants: [
          {
            name: "home",
            extensions: [{ from: "./extensions/mail", settings: account("${secret:gone}") }],
          },
        ],
      }),
    );
    await expect(loadConfig(config)).rejects.toThrow(/set those settings again/);
  });
});
