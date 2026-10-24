import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { databaseEncryption, LOBBY, loadConfig, openAssistant } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { backup, restore } from "../src/commands/backup.ts";

const context = BACKGROUND_CONTEXT;
const MAIN = join(import.meta.dirname, "../dist/main.js");

let dir: string;
let home: string;
let config: string;

/** What `run` printed with console.log, one entry per call. */
async function printed(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => lines.push(args.join(" ")));
  try {
    await run();
  } finally {
    log.mockRestore();
  }
  return lines;
}

/** Writes a config for robin in `home`, with `extra` in it, and a player and a fact in its database. */
async function setUp(extra: object = {}): Promise<void> {
  await writeFile(
    config,
    JSON.stringify({ assistants: [{ name: "robin", database: "data/robin.sqlite" }], ...extra }),
  );
  const loaded = await loadConfig(config);
  // Encrypted, as every database the CLI makes is.
  const nudge = await openAssistant(loaded, loaded.assistants[0]!, context, { encryptNew: true });
  await nudge.players.invite("Ingrid Hansen", context);
  await nudge.memory.remember(LOBBY, "The spare key is under the blue flowerpot", context);
  await nudge.close(context);
}

/** Opens the assistant restored into `restored`, and says who and what it knows. */
async function contents(restored: string) {
  const loaded = await loadConfig(join(restored, "nudge.json"));
  const nudge = await openAssistant(loaded, loaded.assistants[0]!, context);
  try {
    return {
      players: (await nudge.players.list(context)).map((player) => player.displayName),
      memory: (await nudge.memory.visible(LOBBY, context)).map((fact) => fact.text),
    };
  } finally {
    await nudge.close(context);
  }
}

const KNOWN = {
  players: ["Ingrid Hansen"],
  memory: ["The spare key is under the blue flowerpot"],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-cli-backup-test-"));
  home = join(dir, "home");
  config = join(home, "nudge.json");
  await mkdir(home);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("nudge backup", () => {
  it("asks where to when neither --to nor the config says", async () => {
    await setUp();
    await expect(backup({ config })).rejects.toMatchObject({
      name: "UsageError",
      message: 'Where to? Give --to <dir>, or set "backup": { "dir": … } in the config',
    });
  });

  it("makes the key the first time, and says to keep a copy of it", async () => {
    await setUp();
    const keyFile = join(home, "nudge-backup.key");
    const first = await printed(() => backup({ config, to: join(dir, "backups") }));
    expect(first[0]).toBe(
      `Made a backup key in ${keyFile}. Without it no backup can be read: keep a copy somewhere ` +
        "other than this machine and the backups (a password manager, a printout).",
    );
    expect(first[1]).toMatch(
      new RegExp(`^Backed up to ${join(dir, "backups")}/nudge-\\d{8}T\\d{6}Z\\.nudgebackup$`),
    );
    const key = await readFile(keyFile, "utf8");

    const second = await printed(() => backup({ config, to: join(dir, "backups") }));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatch(/^Backed up to /);
    expect(await readFile(keyFile, "utf8")).toBe(key);
  });

  it("keeps only the config's number of backups in its backup.dir", async () => {
    await setUp({ backup: { dir: "backups", keep: 2 } });
    vi.useFakeTimers({ toFake: ["Date"] });
    const deleted: string[] = [];
    for (const at of ["2026-10-01T10:00:00Z", "2026-10-02T10:00:00Z", "2026-10-03T10:00:00Z"]) {
      vi.setSystemTime(new Date(at));
      deleted.push(
        ...(await printed(() => backup({ config }))).filter((line) => line.startsWith("Deleted")),
      );
    }
    expect(deleted).toEqual([
      `Deleted the old backup ${join(home, "backups", "nudge-20261001T100000Z.nudgebackup")}`,
    ]);
    expect((await readdir(join(home, "backups"))).sort()).toEqual([
      "nudge-20261002T100000Z.nudgebackup",
      "nudge-20261003T100000Z.nudgebackup",
    ]);
  });
});

describe("nudge restore", () => {
  it("needs a backup and a place to put it", async () => {
    await expect(restore({ config, to: join(dir, "x"), force: false })).rejects.toThrow(
      "restore needs a backup: nudge restore <file> --to <dir>",
    );
    await expect(restore({ config, file: "b.nudgebackup", force: false })).rejects.toThrow(
      "restore needs --to <dir>: an empty directory to unpack into",
    );
  });

  it("unpacks a backup with the key beside the config, and won't overwrite without --force", async () => {
    await setUp();
    const made = await printed(() => backup({ config, to: join(dir, "backups") }));
    const file = made.at(-1)!.slice("Backed up to ".length);
    const restored = join(dir, "restored");

    const lines = await printed(() => restore({ config, file, to: restored, force: false }));
    expect(lines[0]).toMatch(
      new RegExp(`^Restored \\d+ files of robin from \\d{4}-\\S+Z into ${restored}\\.$`),
    );
    expect(lines[1]).toContain("nudge serve -c <dir>/nudge.json");
    expect(await contents(restored)).toEqual(KNOWN);

    await expect(restore({ config, file, to: restored, force: false })).rejects.toThrow(
      /exists; restore elsewhere/,
    );
    await printed(() => restore({ config, file, to: restored, force: true }));
    expect(await contents(restored)).toEqual(KNOWN);
  });
});

describe("nudge backup, then nudge restore --kit on a new machine", () => {
  /** Runs the CLI as `nudge <args>` would, without exiting; resolves with its code and output. */
  async function nudge(...args: string[]): Promise<{ code: number; out: string[] }> {
    let code = -1;
    const out = await printed(async () => (code = await main(args)));
    return { code, out };
  }

  it("brings everything back with the kit's passphrase, and only with it", async () => {
    await setUp();
    vi.stubEnv("NUDGE_KIT_PASSPHRASE", "correct horse battery");
    const kit = join(dir, "kit.json");
    expect((await nudge("backup", "-c", config, "--to", join(dir, "backups"))).code).toBe(0);
    expect(await nudge("kit", kit, "-c", config)).toEqual({
      code: 0,
      out: [`Wrote ${kit}. Move it off this machine, and keep the passphrase apart from it.`],
    });
    const [file] = await readdir(join(dir, "backups"));

    // The machine is gone, with its config, database key and backup key: only the backup and
    // the kit are left.
    await rm(home, { recursive: true });
    const elsewhere = join(dir, "new-machine", "nudge.json");
    const restored = join(dir, "restored");

    vi.stubEnv("NUDGE_KIT_PASSPHRASE", "wrong horse battery");
    const args = ["restore", join(dir, "backups", file!), "--kit", kit, "--to", restored];
    await expect(nudge(...args, "-c", elsewhere)).rejects.toMatchObject({ name: "UsageError" });
    expect(existsSync(restored)).toBe(false);

    vi.stubEnv("NUDGE_KIT_PASSPHRASE", "correct horse battery");
    const { code, out } = await nudge(...args, "-c", elsewhere);
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Restored \d+ files of robin from /);
    expect(await databaseEncryption(join(restored, "data/robin.sqlite"))).toBe("encrypted");
    expect(await contents(restored)).toEqual(KNOWN);
  });

  // The same as a process, as someone would type it. Runs on the built CLI (pnpm build).
  it.skipIf(!existsSync(MAIN))(
    "works from the built CLI, with the passphrase from the environment",
    async () => {
      await setUp();
      const run = (...args: string[]) =>
        promisify(execFile)(process.execPath, [MAIN, ...args], {
          env: { ...process.env, NUDGE_KIT_PASSPHRASE: "correct horse battery" },
        });
      const backedUp = await run("backup", "-c", config, "--to", join(dir, "backups"));
      expect(backedUp.stdout).toMatch(/Made a backup key in .*\nBacked up to /);
      const kit = join(dir, "kit.json");
      await run("kit", kit, "-c", config);
      const [file] = await readdir(join(dir, "backups"));
      await rm(home, { recursive: true });

      const restored = join(dir, "restored");
      const { stdout } = await run(
        "restore",
        join(dir, "backups", file!),
        "--kit",
        kit,
        "--to",
        restored,
        "-c",
        join(dir, "new-machine", "nudge.json"),
      );
      expect(stdout).toMatch(/^Restored \d+ files of robin from /);
      expect(await contents(restored)).toEqual(KNOWN);

      // Without the kit, the key isn't there to read it.
      const failed = await run(
        "restore",
        join(dir, "backups", file!),
        "--to",
        join(dir, "again"),
        "-c",
        join(dir, "new-machine", "nudge.json"),
      ).catch((error: { code: number; stderr: string }) => error);
      expect(failed).toMatchObject({ code: 1 });
      expect((failed as { stderr: string }).stderr).toContain("No backup key");
    },
    30_000,
  );
});
