import { access, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class DatabaseInUse extends Error {
  override name = "DatabaseInUse";
  constructor(
    readonly database: string,
    readonly pid: number,
  ) {
    super(`${database} is open in process ${pid}; stop it first, or talk to it with --url`);
  }
}

/** Lock files this process holds or is taking, so a second open in the same process is refused. */
const held = new Map<string, symbol>();

/** SQLite's result codes this module tells apart. */
const SQLITE_BUSY = 5;
const SQLITE_NOTADB = 26;

/**
 * Claims `database` for this process through `<database>.lock`, a small SQLite database this
 * process keeps a write transaction open on. Pi Durable keeps state in memory, so a second process
 * on the same file would never see the first's writes. The lock is SQLite's, a POSIX record lock,
 * so the kernel drops it when the process ends however it ends: nothing is left to take over after
 * a crash, and two containers on one volume are told apart even when both servers have the same
 * pid. The lock file records the holder's pid for `DatabaseInUse` and is left in place on release:
 * deleting it could let a process that opened the old file and one that makes a new one both hold
 * a lock. Resolves with the release.
 */
export async function lockDatabase(database: string): Promise<() => Promise<void>> {
  const path = resolve(`${database}.lock`);
  // Reserved before anything is awaited, so two opens in this process can't both get through.
  if (held.has(path)) throw new DatabaseInUse(database, process.pid);
  const claim = Symbol(path);
  held.set(path, claim);
  let db: DatabaseSync;
  try {
    db = await claimFile(path, database);
  } catch (error) {
    held.delete(path);
    throw error;
  }
  return async () => {
    if (held.get(path) !== claim) return;
    held.delete(path);
    // Closing ends the transaction, and with it the lock.
    db.close();
  };
}

/**
 * The pid of the process that has `database` open, or undefined when none has. From another pid
 * namespace, such as another container, the pid is that namespace's.
 */
export async function databaseHolder(database: string): Promise<number | undefined> {
  const path = resolve(`${database}.lock`);
  if (held.has(path)) return process.pid;
  if (!(await exists(path))) return undefined;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return undefined;
  } catch (error) {
    if (sqliteCode(error) === SQLITE_BUSY) return await readHolder(db);
    if (sqliteCode(error) !== SQLITE_NOTADB) throw error;
    const pid = await legacyHolder(path);
    return pid !== undefined && alive(pid) ? pid : undefined;
  } finally {
    db.close();
  }
}

async function claimFile(path: string, database: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  for (let attempt = 0; ; attempt++) {
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      // Only one connection gets a write transaction, so the pid is written by the one that won.
      db.exec("BEGIN IMMEDIATE");
      db.exec("CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL)");
      db.exec("DELETE FROM holder");
      db.prepare("INSERT INTO holder (pid) VALUES (?)").run(process.pid);
      // A process reading the pid may hold the file for a moment; the commit waits for it.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("COMMIT");
      db.exec("PRAGMA busy_timeout = 0");
      // Held from here until the connection closes or the process ends. Another process that
      // slipped in since the commit has the lock now, and this one is refused below.
      db.exec("BEGIN IMMEDIATE");
      return db;
    } catch (error) {
      if (sqliteCode(error) === SQLITE_BUSY) {
        const pid = await readHolder(db);
        db.close();
        throw new DatabaseInUse(database, pid ?? 0);
      }
      db.close();
      if (sqliteCode(error) !== SQLITE_NOTADB || attempt > 0) throw error;
    }
    // A pid file from before the lock was SQLite's: kept while that process lives.
    const pid = await legacyHolder(path);
    if (pid !== undefined && pid !== process.pid && alive(pid))
      throw new DatabaseInUse(database, pid);
    await unlink(path).catch(() => {});
  }
}

/** The pid the holder recorded; a holder that has just won may not have written it yet. */
async function readHolder(db: DatabaseSync): Promise<number | undefined> {
  db.exec("PRAGMA busy_timeout = 5000");
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const row = db.prepare("SELECT pid FROM holder").get() as { pid: number } | undefined;
      if (row !== undefined) return row.pid;
    } catch {
      // No holder table yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

async function legacyHolder(path: string): Promise<number | undefined> {
  const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function sqliteCode(error: unknown): number | undefined {
  return (error as { errcode?: number }).errcode;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
