import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseInUse, databaseHolder, lockDatabase } from "../src/index.ts";

const lockModule = fileURLToPath(new URL("../src/storage-lock.ts", import.meta.url));

/** Another process that takes the lock and keeps it until killed; resolves once it holds it. */
async function holdInChild(database: string): Promise<ChildProcess> {
  const script =
    `const { lockDatabase } = await import(${JSON.stringify(lockModule)});` +
    `await lockDatabase(${JSON.stringify(database)});` +
    `process.stdout.write("locked\\n");` +
    `setInterval(() => {}, 1 << 30);`;
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  for await (const chunk of child.stdout!) {
    output += String(chunk);
    if (output.includes("locked")) return child;
  }
  throw new Error(`the child exited without taking the lock: ${output}`);
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe("database lock", () => {
  let dir: string;
  let database: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-lock-"));
    database = join(dir, "nudge.db");
  });

  afterEach(async () => {
    for (const child of children.splice(0)) await kill(child);
    await rm(dir, { recursive: true, force: true });
  });

  it("is free again once released", async () => {
    const unlock = await lockDatabase(database);
    expect(await databaseHolder(database)).toBe(process.pid);
    await unlock();
    expect(await databaseHolder(database)).toBeUndefined();
    await (
      await lockDatabase(database)
    )();
  });

  it("refuses a database another live process has open", async () => {
    const child = await holdInChild(database);
    children.push(child);
    const error = await lockDatabase(database).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DatabaseInUse);
    expect((error as DatabaseInUse).pid).toBe(child.pid);
    expect(await databaseHolder(database)).toBe(child.pid);
  });

  it("takes over the lock of a process that was killed", async () => {
    // SIGKILL leaves the lock file behind, but the kernel drops the lock on it.
    const child = await holdInChild(database);
    await kill(child);
    expect(await databaseHolder(database)).toBeUndefined();
    const unlock = await lockDatabase(database);
    expect(await databaseHolder(database)).toBe(process.pid);
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

  it("lets only one of two opens at once in this process through", async () => {
    const results = await Promise.allSettled([lockDatabase(database), lockDatabase(database)]);
    const taken = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(taken).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(DatabaseInUse);
    await (taken[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  });

  it("leaves a lock it no longer holds alone when released twice", async () => {
    const unlock = await lockDatabase(database);
    await unlock();
    const again = await lockDatabase(database);
    await unlock();
    expect(await databaseHolder(database)).toBe(process.pid);
    await again();
  });

  describe("a pid file from an older version", () => {
    it("is taken over when its process is gone", async () => {
      const gone = spawnSync(process.execPath, ["-e", ""]).pid;
      await writeFile(`${database}.lock`, String(gone));
      const unlock = await lockDatabase(database);
      expect(await databaseHolder(database)).toBe(process.pid);
      await unlock();
    });

    it("is taken over when it holds our own pid", async () => {
      // A container restarted after a crash: the server has the same pid as last time.
      await writeFile(`${database}.lock`, String(process.pid));
      await (
        await lockDatabase(database)
      )();
    });

    it("is respected while its process lives", async () => {
      await writeFile(`${database}.lock`, String(process.ppid));
      const error = await lockDatabase(database).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(DatabaseInUse);
      expect((error as DatabaseInUse).pid).toBe(process.ppid);
      expect(await readFile(`${database}.lock`, "utf8")).toBe(String(process.ppid));
      expect(await databaseHolder(database)).toBe(process.ppid);
    });
  });
});
