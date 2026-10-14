import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  NodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";

/** The part of better-sqlite3-multiple-ciphers used here; its typings aren't reachable through its `exports`. */
type CipherDatabase = {
  pragma(source: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
};
const Database = createRequire(import.meta.url)("better-sqlite3-multiple-ciphers") as new (
  path: string,
  options?: { timeout?: number },
) => CipherDatabase;

/** Every unencrypted SQLite file starts with these 16 bytes; an encrypted one doesn't. */
const SQLITE_HEADER = "SQLite format 3\0";

export class DatabaseKeyError extends Error {
  override name = "DatabaseKeyError";
}

export type DatabaseKey = {
  readonly key: Buffer;
  /** Where it came from, for doctor and error messages. */
  readonly source: "NUDGE_DB_KEY" | string;
};

export type DatabaseEncryption = "encrypted" | "plain" | "missing";

/** Whether the database file exists and, if so, whether it is encrypted, read from its header. */
export async function databaseEncryption(database: string): Promise<DatabaseEncryption> {
  const file = await open(database, "r").catch(() => undefined);
  if (file === undefined) return "missing";
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, 16, 0);
    if (bytesRead === 0) return "missing";
    return header.toString("latin1") === SQLITE_HEADER ? "plain" : "encrypted";
  } finally {
    await file.close();
  }
}

/**
 * The database's key: `NUDGE_DB_KEY` (base64, 32 bytes) when set, else the `<database>.key` file
 * when it exists. Undefined means the database is stored unencrypted.
 */
export async function databaseKey(database: string): Promise<DatabaseKey | undefined> {
  const fromEnv = process.env.NUDGE_DB_KEY?.trim();
  if (fromEnv) return { key: parseKey(fromEnv, "NUDGE_DB_KEY"), source: "NUDGE_DB_KEY" };
  const file = keyFile(database);
  if (!existsSync(file)) return undefined;
  return { key: parseKey(await readFile(file, "utf8"), file), source: file };
}

export function keyFile(database: string): string {
  return `${database}.key`;
}

/**
 * Opens the assistant's storage, encrypted with SQLite3 Multiple Ciphers when the file is
 * encrypted or a key is set for a new one, and with Node's built-in SQLite otherwise.
 */
export async function openDatabaseStorage(database: string): Promise<Storage> {
  const state = await databaseEncryption(database);
  const key = await databaseKey(database);
  if (state === "encrypted" && key === undefined)
    throw new DatabaseKeyError(
      `${database} is encrypted, but there is no key: set NUDGE_DB_KEY or restore ${keyFile(database)}`,
    );
  if (state === "plain" && key !== undefined)
    throw new DatabaseKeyError(
      `${database} is not encrypted, but ${key.source} is set: run "nudge db encrypt", or remove the key`,
    );
  if (key === undefined) return openNodeSqliteStorage(database);
  return SqliteStorage.open(await openEncrypted(database, key));
}

/**
 * Encrypts an unencrypted database in place under `NUDGE_DB_KEY`, or under a new key file next to
 * it. The caller holds the database lock. Returns where the key is.
 */
export async function encryptDatabase(database: string): Promise<string> {
  if ((await databaseEncryption(database)) !== "plain")
    throw new DatabaseKeyError(`${database} is not an unencrypted database`);
  const existing = await databaseKey(database);
  const key = existing ?? { key: randomBytes(32), source: keyFile(database) };
  if (existing === undefined)
    await writeFile(key.source, key.key.toString("base64"), { mode: 0o600, flag: "wx" });
  try {
    rekey(new Database(database), key.key);
  } catch (error) {
    if (existing === undefined) await unlink(key.source).catch(() => {});
    throw error;
  }
  await verify(database, key);
  return key.source;
}

/** Decrypts an encrypted database in place and deletes its key file. The caller holds the lock. */
export async function decryptDatabase(database: string): Promise<void> {
  if ((await databaseEncryption(database)) !== "encrypted")
    throw new DatabaseKeyError(`${database} is not an encrypted database`);
  const key = await databaseKey(database);
  if (key === undefined)
    throw new DatabaseKeyError(
      `${database} is encrypted, but there is no key: set NUDGE_DB_KEY or restore ${keyFile(database)}`,
    );
  const db = new Database(database);
  db.pragma(`hexkey='${key.key.toString("hex")}'`);
  rekey(db, undefined);
  if (key.source !== "NUDGE_DB_KEY") await unlink(key.source);
}

async function openEncrypted(database: string, key: DatabaseKey): Promise<NodeSqliteDatabase> {
  await mkdir(dirname(database), { recursive: true });
  const db = new Database(database, { timeout: 5_000 });
  try {
    db.pragma(`hexkey='${key.key.toString("hex")}'`);
    // A wrong key only shows when a page is read.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("wal_autocheckpoint = 1000");
  } catch (error) {
    db.close();
    throw new DatabaseKeyError(
      `Cannot open ${database} with the key from ${key.source}: ${(error as Error).message}`,
    );
  }
  // better-sqlite3 has the same exec/prepare/run/get/all/close surface the adapter uses.
  return new NodeSqliteDatabase(db as unknown as DatabaseSync);
}

/** Changes the key of an open database, or removes it with `undefined`, then closes it. */
function rekey(db: CipherDatabase, key: Buffer | undefined): void {
  try {
    // Rekeying isn't supported in WAL mode: fold the log in and switch out of it first.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.pragma(key === undefined ? "rekey=''" : `hexrekey='${key.toString("hex")}'`);
    db.pragma("journal_mode = WAL");
  } finally {
    db.close();
  }
}

async function verify(database: string, key: DatabaseKey): Promise<void> {
  if ((await databaseEncryption(database)) !== "encrypted")
    throw new DatabaseKeyError(`${database} is still unencrypted after rekeying`);
  const db = await openEncrypted(database, key);
  await db.close();
}

function parseKey(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new DatabaseKeyError(`${source} is not a base64 32-byte key`);
  return key;
}
