import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupError,
  backupKey,
  createBackup,
  createNudge,
  databaseEncryption,
  encryptDatabase,
  lastBackupAt,
  LOBBY,
  loadConfig,
  type Nudge,
  pruneBackups,
  restoreBackup,
  ServerKeys,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

describe("backups", () => {
  let dir: string;
  let models: ReturnType<typeof createModels>;
  let model: { provider: string; modelId: string };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-backup-test-"));
    const faux = fauxProvider();
    models = createModels();
    models.setProvider(faux.provider);
    model = { provider: faux.provider.id, modelId: faux.getModel().id };
    await mkdir(join(dir, "home"));
    await writeFile(
      join(dir, "home", "nudge.json"),
      JSON.stringify({ assistants: [{ name: "robin", database: "data/robin.sqlite" }] }),
    );
  });

  afterEach(async () => {
    delete process.env.NUDGE_DB_KEY;
    await rm(dir, { recursive: true, force: true });
  });

  /** The assistant the config in `home` describes, with a player and something remembered. */
  const openHome = async (home: string) => {
    const config = await loadConfig(join(home, "nudge.json"));
    const nudge = await createNudge(
      { database: config.assistants[0]!.database!, models, model },
      context,
    );
    return { config, nudge };
  };
  const fill = async (nudge: Nudge) => {
    await nudge.players.invite("Ingrid Hansen", context);
    await nudge.memory.remember(LOBBY, "The spare key is under the blue flowerpot", context);
    await mkdir(join(dir, "home", "data", "robin.sqlite.extensions", "lists"), { recursive: true });
    await writeFile(
      join(dir, "home", "data", "robin.sqlite.extensions", "lists", "note"),
      "extension data",
    );
    new ServerKeys(join(dir, "home", "server", "keys"), () => []).set("anthropic", "sk-ant-x");
  };

  it("backs up a running assistant, unreadable without the key, and restores it whole", async () => {
    const home = join(dir, "home");
    const { config, nudge } = await openHome(home);
    await fill(nudge);
    const keyFile = join(dir, "backup.key");
    const key = await backupKey(keyFile, true);
    expect((await readFile(keyFile, "utf8")).trim()).toHaveLength(44);

    // The assistant stays open, as under `nudge serve`.
    const file = await createBackup({
      configPath: join(home, "nudge.json"),
      config,
      dir: join(dir, "backups"),
      key,
    });
    await nudge.close(context);
    expect(file).toMatch(/nudge-\d{8}T\d{6}Z\.nudgebackup$/);
    const raw = await readFile(file);
    for (const secret of ["Ingrid", "flowerpot", "extension data", "robin.sqlite", "sk-ant"])
      expect(raw.includes(Buffer.from(secret))).toBe(false);

    const restored = join(dir, "restored");
    const manifest = await restoreBackup({ file, key, dir: restored });
    expect(manifest.assistants).toEqual(["robin"]);
    expect(manifest.files.map((f) => f.path).sort()).toEqual([
      "data/robin.sqlite",
      "data/robin.sqlite.extensions/lists/note",
      "nudge.json",
      "server/keys/key",
      "server/keys/secrets.enc",
    ]);
    expect(await readFile(join(restored, "data/robin.sqlite.extensions/lists/note"), "utf8")).toBe(
      "extension data",
    );
    const back = await openHome(restored);
    expect((await back.nudge.players.list(context)).map((p) => p.displayName)).toEqual([
      "Ingrid Hansen",
    ]);
    expect((await back.nudge.memory.visible(LOBBY, context)).map((f) => f.text)).toEqual([
      "The spare key is under the blue flowerpot",
    ]);
    await back.nudge.close(context);

    // A wrong key, a cut archive and files in the way are refused.
    await expect(
      restoreBackup({ file, key: Buffer.alloc(32, 7), dir: join(dir, "x") }),
    ).rejects.toThrow("Wrong backup key, or the backup is damaged");
    await expect(restoreBackup({ file, key, dir: restored })).rejects.toThrow(
      /exists; restore elsewhere/,
    );
    await truncate(file, raw.length - 10);
    await expect(restoreBackup({ file, key, dir: join(dir, "y") })).rejects.toThrow(BackupError);
  });

  it("keeps an encrypted database encrypted, with its key file, so the backup key alone restores it", async () => {
    const home = join(dir, "home");
    const { config, nudge } = await openHome(home);
    await fill(nudge);
    await nudge.close(context);
    const database = join(home, "data/robin.sqlite");
    expect(await encryptDatabase(database)).toBe(`${database}.key`);
    const key = Buffer.alloc(32, 9);
    const file = await createBackup({
      configPath: join(home, "nudge.json"),
      config,
      dir: join(dir, "b"),
      key,
    });
    expect((await readFile(file)).includes(await readFile(`${database}.key`))).toBe(false);
    // The machine is gone: the original and its key with it.
    await rm(home, { recursive: true });
    const restored = join(dir, "restored");
    await restoreBackup({ file, key, dir: restored });
    expect(await databaseEncryption(join(restored, "data/robin.sqlite"))).toBe("encrypted");
    const back = await openHome(restored);
    expect((await back.nudge.players.list(context)).map((p) => p.displayName)).toEqual([
      "Ingrid Hansen",
    ]);
    await back.nudge.close(context);
  });

  it("keeps the newest backups and knows when the last was made", async () => {
    const backups = join(dir, "backups");
    await mkdir(backups);
    for (const stamp of ["20261001T010000Z", "20261002T010000Z", "20261003T010000Z"])
      await writeFile(join(backups, `nudge-${stamp}.nudgebackup`), "");
    await writeFile(join(backups, "other.txt"), "");
    expect(await lastBackupAt(backups)).toEqual(new Date("2026-10-03T01:00:00Z"));
    await pruneBackups(backups, 2);
    expect((await readdir(backups)).sort()).toEqual([
      "nudge-20261002T010000Z.nudgebackup",
      "nudge-20261003T010000Z.nudgebackup",
      "other.txt",
    ]);
    expect(await lastBackupAt(join(dir, "none"))).toBeUndefined();
  });
});
