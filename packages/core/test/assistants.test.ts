import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AssistantExists,
  AssistantNotFound,
  Assistants,
  ConfigError,
  LOBBY,
  openAssistant,
} from "../src/index.ts";
import { SettingSecrets } from "../src/setting-secrets.ts";

const context = BACKGROUND_CONTEXT;

describe("Assistants", () => {
  let dir: string;
  let configPath: string;
  let assistants: Assistants | undefined;
  const lines: string[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };

  const open = () =>
    Assistants.open({
      configPath,
      open: (config, assistant) => openAssistant(config, assistant, context, { models }),
      context,
      say: (line) => lines.push(line),
    });
  const config = async () =>
    JSON.parse(await readFile(configPath, "utf8")) as {
      $comment?: string;
      assistants: Record<string, unknown>[];
    };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-assistants-"));
    configPath = join(dir, "nudge.json");
    lines.length = 0;
    await writeFile(
      configPath,
      JSON.stringify({ $comment: "kept", assistants: [{ name: "robin", model }] }),
    );
  });

  afterEach(async () => {
    await assistants?.close();
    assistants = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("opens every assistant in the config", async () => {
    assistants = await open();
    expect([...assistants.running.keys()]).toEqual(["robin"]);
  });

  it("creates an assistant while the others run, and writes it to the config", async () => {
    assistants = await open();
    const robin = assistants.running.get("robin");
    const pocket = await assistants.create({ name: "pocket", displayName: "Pocket", model });
    expect(assistants.running.get("pocket")).toBe(pocket);
    expect(assistants.running.get("robin")).toBe(robin);
    expect(pocket.displayName).toBe("Pocket");
    expect(existsSync(join(dir, "data", "pocket.sqlite"))).toBe(true);
    const written = await config();
    expect(written.$comment).toBe("kept");
    expect(written.assistants.map((a) => a.name)).toEqual(["robin", "pocket"]);
    expect(written.assistants[1]).toEqual({ name: "pocket", displayName: "Pocket", model });
  });

  it("refuses a name in use, a bad name, or a database already there", async () => {
    assistants = await open();
    await expect(assistants.create({ name: "robin" })).rejects.toBeInstanceOf(AssistantExists);
    await expect(assistants.create({ name: "No Spaces" })).rejects.toBeInstanceOf(ConfigError);
    await writeFile(join(dir, "data", "old.sqlite"), "someone's history");
    await expect(assistants.create({ name: "old", model })).rejects.toThrow(/already exists/);
    expect((await config()).assistants.map((a) => a.name)).toEqual(["robin"]);
  });

  it("changes settings by reopening that assistant alone, keeping its data", async () => {
    assistants = await open();
    const before = assistants.running.get("robin")!;
    await before.players.ensure("ann", "Ann", context);
    const after = await assistants.update("robin", {
      displayName: "Robin",
      instructions: "Be brief.",
    });
    expect(after).not.toBe(before);
    expect(assistants.running.get("robin")).toBe(after);
    expect(after.displayName).toBe("Robin");
    expect((await after.players.get("ann", context))?.displayName).toBe("Ann");
    expect((await config()).assistants[0]).toMatchObject({ instructions: "Be brief." });
    await assistants.update("robin", { instructions: null });
    expect((await config()).assistants[0]).not.toHaveProperty("instructions");
  });

  it("sets the style and autonomy, refuses ones it doesn't know, and clears them", async () => {
    assistants = await open();
    await assistants.update("robin", { style: "detailed", autonomy: "independent" });
    expect((await config()).assistants[0]).toMatchObject({
      style: "detailed",
      autonomy: "independent",
    });
    expect((await assistants.list())[0]).toMatchObject({
      style: "detailed",
      autonomy: "independent",
    });
    await expect(
      assistants.update("robin", { style: "chatty" as "concise" }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect((await config()).assistants[0]).toMatchObject({ style: "detailed" });
    await assistants.update("robin", { style: null, autonomy: null });
    expect((await config()).assistants[0]).not.toHaveProperty("style");
    expect((await config()).assistants[0]).not.toHaveProperty("autonomy");
  });

  it("keeps the assistant as it was when its new settings don't open", async () => {
    assistants = await open();
    await expect(
      assistants.update("robin", { budget: { monthlyUsd: -1 } }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(assistants.running.has("robin")).toBe(true);
    expect((await config()).assistants[0]).not.toHaveProperty("budget");
    await expect(assistants.update("nobody", {})).rejects.toBeInstanceOf(AssistantNotFound);
  });

  it("deletes an assistant after backing it up, files and all", async () => {
    assistants = await open();
    await assistants.create({ name: "pocket", model });
    const database = join(dir, "data", "pocket.sqlite");
    const backedUp: string[][] = [];
    const kept = await assistants.remove("pocket", async (only) => {
      backedUp.push(only.assistants.map((a) => a.name));
      expect(existsSync(database)).toBe(true);
      return "backup-file";
    });
    expect(kept).toBe("backup-file");
    expect(backedUp).toEqual([["pocket"]]);
    expect(assistants.running.has("pocket")).toBe(false);
    expect(existsSync(database)).toBe(false);
    expect(existsSync(`${database}.extensions`)).toBe(false);
    expect((await config()).assistants.map((a) => a.name)).toEqual(["robin"]);
  });

  it("drops a deleted assistant's setting secrets, and keeps the others'", async () => {
    assistants = await open();
    await assistants.create({ name: "pocket", model });
    const secrets = new SettingSecrets(dir);
    const id = (reference: string) => /^\$\{secret:([\w-]+)\}$/.exec(reference)![1]!;
    const pocket = id(secrets.put("pocket", "hunter2"));
    const robin = id(secrets.put("robin", "swordfish"));
    await assistants.remove("pocket", async () => "backup-file");
    const reopened = new SettingSecrets(dir);
    expect(reopened.get("pocket", pocket)).toBeUndefined();
    expect(reopened.get("robin", robin)).toBe("swordfish");
  });

  it("deletes nothing when the backup fails", async () => {
    assistants = await open();
    await expect(
      assistants.remove("robin", async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(assistants.running.has("robin")).toBe(true);
    expect(existsSync(join(dir, "data", "robin.sqlite"))).toBe(true);
  });

  it("reloads the config after an edit by hand", async () => {
    assistants = await open();
    const robin = assistants.running.get("robin")!;
    const lobby = await robin.rooms.get(LOBBY, context);
    expect(lobby).toBeDefined();
    await writeFile(
      configPath,
      JSON.stringify({
        assistants: [
          { name: "robin", model },
          { name: "pocket", model, displayName: "Pocket" },
        ],
      }),
    );
    await assistants.reload();
    expect(assistants.running.get("robin")).toBe(robin);
    expect(assistants.running.get("pocket")?.displayName).toBe("Pocket");

    await writeFile(
      configPath,
      JSON.stringify({ assistants: [{ name: "pocket", model, displayName: "Pocket 2" }] }),
    );
    await assistants.reload();
    expect([...assistants.running.keys()]).toEqual(["pocket"]);
    expect(assistants.running.get("pocket")?.displayName).toBe("Pocket 2");
    expect(lines).toContain("robin: no longer in the config; closed");
  });

  it("reloads the other extensions when one in the config is broken", async () => {
    assistants = await open();
    const robin = assistants.running.get("robin")!;
    const bad = join(dir, "bad.mjs");
    await writeFile(bad, "export default {;\n");
    await writeFile(join(dir, "plain.mjs"), 'export default { name: "plain" };\n');
    await writeFile(
      configPath,
      JSON.stringify({
        assistants: [
          { name: "robin", model, extensions: [{ from: bad }, { from: "./plain.mjs" }] },
        ],
      }),
    );
    await assistants.reload();
    expect(assistants.running.get("robin")).toBe(robin);
    expect(robin.extensions()).toEqual([{ name: "plain" }]);
    expect(robin.brokenExtensions().map((e) => e.name)).toEqual([bad]);
    expect(lines).toContain("robin: extensions reloaded: plain");
    expect(lines.some((line) => line.startsWith(`robin: ${bad} failed to start, left out:`))).toBe(
      true,
    );
  });
});
