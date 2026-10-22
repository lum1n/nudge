import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseInUse, lockDatabase } from "../src/index.ts";

describe("database lock", () => {
  let dir: string;
  let database: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-lock-"));
    database = join(dir, "nudge.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes our pid, and removes the lock on release", async () => {
    const unlock = await lockDatabase(database);
    expect(await readFile(`${database}.lock`, "utf8")).toBe(String(process.pid));
    await unlock();
    await expect(readFile(`${database}.lock`)).rejects.toThrow();
  });

  it("takes over a lock left by a process that is gone", async () => {
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(`${database}.lock`, String(gone));
    const unlock = await lockDatabase(database);
    expect(await readFile(`${database}.lock`, "utf8")).toBe(String(process.pid));
    await unlock();
  });

  it("takes over a lock with our own pid that this process didn't take", async () => {
    // A container restarted after a crash: the server has the same pid as last time.
    await writeFile(`${database}.lock`, String(process.pid));
    const unlock = await lockDatabase(database);
    expect(await readFile(`${database}.lock`, "utf8")).toBe(String(process.pid));
    await unlock();
  });

  it("refuses a database this process has open", async () => {
    const unlock = await lockDatabase(database);
    await expect(lockDatabase(database)).rejects.toThrow(DatabaseInUse);
    await unlock();
    await (
      await lockDatabase(database)
    )();
  });

  it("refuses a database another live process has open", async () => {
    await writeFile(`${database}.lock`, String(process.ppid));
    const error = await lockDatabase(database).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DatabaseInUse);
    expect((error as DatabaseInUse).pid).toBe(process.ppid);
    expect(await readFile(`${database}.lock`, "utf8")).toBe(String(process.ppid));
  });

  it("leaves a lock it no longer holds alone when released twice", async () => {
    const unlock = await lockDatabase(database);
    await unlock();
    const again = await lockDatabase(database);
    await unlock();
    expect(await readFile(`${database}.lock`, "utf8")).toBe(String(process.pid));
    await again();
  });
});
