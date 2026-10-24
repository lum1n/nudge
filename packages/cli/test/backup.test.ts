import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { databaseEncryption, LOBBY, loadConfig, openAssistant } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { backup, backupControl, restore } from "../src/commands/backup.ts";
import { checkBackups } from "../src/commands/doctor.ts";

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

/** A WebDAV folder at /dav/ over memory, behind basic auth as ann:hunter2. */
async function webDav(): Promise<{ url: string; files: Map<string, Buffer>; close(): void }> {
  const files = new Map<string, Buffer>();
  const auth = `Basic ${Buffer.from("ann:hunter2").toString("base64")}`;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.headers.authorization !== auth) {
      response.statusCode = 401;
      response.end("Unauthorized");
      return;
    }
    const name = decodeURIComponent(request.url!.slice("/dav/".length));
    if (request.method === "PUT") {
      files.set(name, Buffer.concat(chunks));
      response.statusCode = 201;
    } else if (request.method === "DELETE") {
      response.statusCode = files.delete(name) ? 204 : 404;
    } else if (request.method === "PROPFIND") {
      response.statusCode = 207;
      response.write('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">');
      for (const href of ["", ...files.keys()])
        response.write(`<D:response><D:href>/dav/${href}</D:href></D:response>`);
      response.write("</D:multistatus>");
    } else response.statusCode = 405;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/dav/`, files, close: () => server.close() };
}

describe("nudge backup to a remote target", () => {
  it("uploads each backup, keeps the config's number there, and only ciphertext leaves", async () => {
    const dav = await webDav();
    try {
      await setUp({
        backup: { dir: "backups", keep: 2, remote: { type: "webdav", url: dav.url } },
      });
      vi.stubEnv("NUDGE_BACKUP_REMOTE_USER", "ann");
      vi.stubEnv("NUDGE_BACKUP_REMOTE_SECRET", "hunter2");
      vi.useFakeTimers({ toFake: ["Date"] });
      const lines: string[] = [];
      for (const at of ["2026-10-01T10:00:00Z", "2026-10-02T10:00:00Z", "2026-10-03T10:00:00Z"]) {
        vi.setSystemTime(new Date(at));
        lines.push(...(await printed(() => backup({ config }))));
      }
      vi.useRealTimers();
      expect(lines).toContain(`Uploaded it to ${dav.url}`);
      expect(lines).toContain(
        `Deleted the old backup nudge-20261001T100000Z.nudgebackup from ${dav.url}`,
      );
      expect([...dav.files.keys()].sort()).toEqual([
        "nudge-20261002T100000Z.nudgebackup",
        "nudge-20261003T100000Z.nudgebackup",
      ]);
      const uploaded = dav.files.get("nudge-20261003T100000Z.nudgebackup")!;
      expect(uploaded.includes("flowerpot")).toBe(false);
      expect(uploaded.includes("Ingrid")).toBe(false);

      // The copy there restores like the one here.
      const copy = join(dir, "downloaded.nudgebackup");
      await writeFile(copy, uploaded);
      const restored = join(dir, "restored");
      await printed(() => restore({ config, file: copy, to: restored, force: false }));
      expect(await contents(restored)).toEqual(KNOWN);

      // The doctor sees it answer, and how old the newest there is.
      const checks: string[] = [];
      await checkBackups(
        (passed, text) => checks.push(`${passed ? "ok" : "FAIL"} ${text}`),
        (text) => checks.push(`warn ${text}`),
        config,
        (await loadConfig(config)).backup!,
        undefined,
        Date.parse("2026-10-03T13:00:00Z"),
      );
      expect(checks).toEqual([
        `ok backups: the newest in ${join(home, "backups")} is 3 hours old`,
        `ok backups: ${dav.url} answers`,
        `ok backups: the newest in ${dav.url} is 3 hours old`,
      ]);
    } finally {
      dav.close();
    }
  });

  it("is set from the apps: checked first, kept in the config and the server's secrets", async () => {
    const dav = await webDav();
    try {
      await setUp();
      let changes = 0;
      const control = backupControl(config, async () => void changes++);
      expect(await control.state()).toEqual({ on: false, everyHours: 24, keep: 14 });
      await expect(control.backUpNow()).rejects.toThrow(/makes no backups/);

      await expect(
        control.setRemote({ type: "webdav", url: dav.url, user: "ann", secret: "wrong" }),
      ).rejects.toThrow("Nudge couldn't write there: PUT /dav/nudge-check.txt: 401 Unauthorized");
      await expect(
        control.setRemote({ type: "s3", endpoint: "https://s3.example", bucket: "b" }),
      ).rejects.toThrow("An S3 bucket needs an access key id and its secret");
      expect(changes).toBe(0);

      const state = await control.setRemote({
        type: "webdav",
        url: dav.url,
        user: "ann",
        secret: "hunter2",
      });
      expect(changes).toBe(1);
      expect(state).toEqual({
        on: true,
        dir: join(home, "backups"),
        everyHours: 24,
        keep: 14,
        remote: { type: "webdav", url: dav.url },
        credentials: { user: "ann", from: "server" },
      });
      const raw = JSON.parse(await readFile(config, "utf8"));
      expect(raw.backup).toEqual({
        dir: "backups",
        everyHours: 24,
        keep: 14,
        remote: { type: "webdav", url: dav.url },
      });
      expect(JSON.stringify(raw)).not.toContain("hunter2");
      expect(dav.files.size).toBe(0);

      // Changed later without the password: the kept one is used.
      await control.setRemote({ type: "webdav", url: dav.url });
      const made = await control.backUpNow();
      expect(made).toEqual({ file: expect.stringMatching(/^nudge-\d{8}T\d{6}Z\.nudgebackup$/) });
      expect([...dav.files.keys()]).toEqual([made.file]);
      expect((await control.state()).lastUploadAt).toBeGreaterThan(0);

      const removed = await control.removeRemote();
      expect(removed.remote).toBeUndefined();
      expect(removed.credentials).toBeUndefined();
      expect(JSON.parse(await readFile(config, "utf8")).backup.remote).toBeUndefined();
    } finally {
      dav.close();
    }
  });

  it("keeps the local backup when the upload fails, and the doctor says so", async () => {
    const dav = await webDav();
    try {
      await setUp({
        backup: { dir: "backups", keep: 2, remote: { type: "webdav", url: dav.url } },
      });
      vi.stubEnv("NUDGE_BACKUP_REMOTE_USER", "ann");
      vi.stubEnv("NUDGE_BACKUP_REMOTE_SECRET", "wrong");
      await expect(printed(() => backup({ config }))).rejects.toThrow(
        /^Upload to .* failed: PUT \/dav\/nudge-\d{8}T\d{6}Z\.nudgebackup: 401 Unauthorized$/,
      );
      expect(await readdir(join(home, "backups"))).toHaveLength(1);
      expect(dav.files.size).toBe(0);

      const checks: string[] = [];
      await checkBackups(
        (passed, text) => checks.push(`${passed ? "ok" : "FAIL"} ${text}`),
        (text) => checks.push(`warn ${text}`),
        config,
        (await loadConfig(config)).backup!,
      );
      expect(checks[1]).toBe(`FAIL backups: ${dav.url}: PROPFIND /dav/: 401 Unauthorized`);
      expect(checks[2]).toMatch(/^warn backups: the last upload, \d+ minutes ago, failed: PUT /);
    } finally {
      dav.close();
    }
  });
});
