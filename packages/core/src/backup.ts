import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NudgeConfig } from "./config.ts";
import { keyFile, snapshotDatabase } from "./encrypted-storage.ts";

/** An archive starts with this, then the chunk nonce prefix, then sealed chunks. */
const MAGIC = Buffer.from("NUDGEBK1");
const CHUNK = 1024 * 1024;
const TAG = 16;
export const BACKUP_SUFFIX = ".nudgebackup";

export class BackupError extends Error {
  override name = "BackupError";
}

/** One file in an archive: where it goes, relative to the config's directory. */
type Entry = { path: string; size: number; mode: number; sha256: string };
type Manifest = { version: 1; createdAt: string; assistants: string[]; files: Entry[] };

/**
 * The backup key: `NUDGE_BACKUP_KEY` (base64, 32 bytes) when set, else the file. With `create`,
 * a missing file is made with a new key, readable only by its owner.
 */
export async function backupKey(file: string, create = false): Promise<Buffer> {
  const fromEnv = process.env.NUDGE_BACKUP_KEY;
  if (fromEnv) return parseKey(fromEnv, "NUDGE_BACKUP_KEY");
  if (existsSync(file)) return parseKey(await readFile(file, "utf8"), file);
  if (!create) throw new BackupError(`No backup key: set NUDGE_BACKUP_KEY or keep ${file}`);
  const key = randomBytes(32);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, key.toString("base64"), { mode: 0o600, flag: "wx" });
  return key;
}

/**
 * What a backup of `config` holds, as absolute paths: every assistant's database (copied
 * consistently, encrypted ones staying so), its key file, its extensions' data, the config file,
 * and the server's own files under `server/` beside it.
 */
async function collect(
  configPath: string,
  config: NudgeConfig,
): Promise<{ source: string; database: boolean }[]> {
  const found: { source: string; database: boolean }[] = [];
  const add = async (source: string, database = false) => {
    if (existsSync(source) && !found.some((f) => f.source === source))
      found.push({ source, database });
  };
  if (existsSync(configPath)) await add(resolve(configPath));
  // The server's own: the model keys set on it (ADR 11).
  for (const file of await walk(join(dirname(resolve(configPath)), "server"))) await add(file);
  for (const assistant of config.assistants) {
    const database = assistant.database;
    if (database === undefined || database === ":memory:") continue;
    await add(database, true);
    await add(keyFile(database));
    for (const file of await walk(`${database}.extensions`)) await add(file);
    await add(join(dirname(database), "push-vapid.json"));
  }
  return found;
}

/** Where a file goes in the archive: under the config's directory if it is there, else under `external/`. */
function archivePath(base: string, source: string): string {
  const inside = relative(base, source);
  const path = inside.startsWith("..") || isAbsolute(inside) ? join("external", source) : inside;
  return path.split(sep).join("/");
}

/**
 * Writes an encrypted backup of every assistant in `config` to `dir`, and returns its path. Safe
 * while `nudge serve` runs.
 */
export async function createBackup(options: {
  readonly configPath: string;
  readonly config: NudgeConfig;
  readonly dir: string;
  readonly key: Buffer;
  readonly now?: Date;
}): Promise<string> {
  const base = dirname(resolve(options.configPath));
  const now = options.now ?? new Date();
  const scratch = await mkdtemp(join(tmpdir(), "nudge-backup-"));
  try {
    const files: { entry: Entry; from: string }[] = [];
    for (const { source, database } of await collect(options.configPath, options.config)) {
      let from = source;
      if (database) {
        from = join(scratch, `${files.length}.sqlite`);
        await snapshotDatabase(source, from);
      }
      const info = await stat(from);
      files.push({
        from,
        entry: {
          path: archivePath(base, source),
          size: info.size,
          mode: (await stat(source)).mode & 0o777,
          sha256: await hashFile(from),
        },
      });
    }
    const manifest: Manifest = {
      version: 1,
      createdAt: now.toISOString(),
      assistants: options.config.assistants.map((a) => a.name),
      files: files.map((f) => f.entry),
    };
    await mkdir(options.dir, { recursive: true });
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const target = join(options.dir, `nudge-${stamp}${BACKUP_SUFFIX}`);
    const partial = `${target}.partial`;
    const writer = await SealedWriter.open(partial, options.key);
    try {
      const head = Buffer.from(JSON.stringify(manifest));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(head.length);
      await writer.write(length);
      await writer.write(head);
      for (const { from } of files) {
        const handle = await open(from, "r");
        try {
          const buffer = Buffer.alloc(CHUNK);
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, CHUNK);
            if (bytesRead === 0) break;
            await writer.write(buffer.subarray(0, bytesRead));
          }
        } finally {
          await handle.close();
        }
      }
      await writer.close();
    } catch (error) {
      await writer.abort();
      await unlink(partial).catch(() => {});
      throw error;
    }
    // Renamed into place only when whole, so a half-written backup never looks like one.
    await rename(partial, target);
    return target;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** What a backup holds, read with its key. */
export async function readBackupManifest(file: string, key: Buffer): Promise<Manifest> {
  const reader = await SealedReader.open(file, key);
  try {
    const length = (await reader.read(4)).readUInt32BE();
    return JSON.parse((await reader.read(length)).toString()) as Manifest;
  } finally {
    await reader.close();
  }
}

/**
 * Unpacks a backup into `dir`, each file where it was relative to the config, and checks every
 * file against its hash. Refuses to overwrite a file unless `force`.
 */
export async function restoreBackup(options: {
  readonly file: string;
  readonly key: Buffer;
  readonly dir: string;
  readonly force?: boolean;
}): Promise<Manifest> {
  const reader = await SealedReader.open(options.file, options.key);
  try {
    const length = (await reader.read(4)).readUInt32BE();
    const manifest = JSON.parse((await reader.read(length)).toString()) as Manifest;
    if (manifest.version !== 1) throw new BackupError(`Unknown backup version ${manifest.version}`);
    const root = resolve(options.dir);
    const targets = manifest.files.map((entry) => {
      const target = resolve(root, ...entry.path.split("/"));
      if (target !== root && !target.startsWith(root + sep))
        throw new BackupError(`${entry.path} would land outside ${root}`);
      return target;
    });
    if (!options.force)
      for (const target of targets)
        if (existsSync(target))
          throw new BackupError(`${target} exists; restore elsewhere, or with --force`);
    for (const [i, entry] of manifest.files.entries()) {
      const target = targets[i]!;
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, "w", entry.mode || 0o600);
      const hash = createHash("sha256");
      try {
        let left = entry.size;
        while (left > 0) {
          const part = await reader.read(Math.min(left, CHUNK));
          hash.update(part);
          await handle.write(part);
          left -= part.length;
        }
      } finally {
        await handle.close();
      }
      if (hash.digest("hex") !== entry.sha256)
        throw new BackupError(`${entry.path} doesn't match its hash`);
    }
    return manifest;
  } finally {
    await reader.close();
  }
}

/** Deletes all but the newest `keep` backups in `dir`; returns the ones deleted. */
export async function pruneBackups(dir: string, keep: number): Promise<string[]> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^nudge-\d{8}T\d{6}Z\.nudgebackup$/.test(name))
    .sort();
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const name of old) await unlink(join(dir, name));
  return old.map((name) => join(dir, name));
}

/** When the newest backup in `dir` was made, from its name; undefined when there is none. */
export async function lastBackupAt(dir: string): Promise<Date | undefined> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^nudge-\d{8}T\d{6}Z\.nudgebackup$/.test(name))
    .sort();
  const last = names.at(-1);
  if (last === undefined) return undefined;
  const [, y, mo, d, h, mi, s] = /^nudge-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(last)!;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!));
}

/**
 * Chunked AES-256-GCM: 1 MiB chunks, each sealed under the nonce prefix and its number, the last
 * one marked in its additional data, so a cut or reordered archive fails to open.
 */
class SealedWriter {
  private pending = Buffer.alloc(0);
  private index = 0;

  private constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly key: Buffer,
    private readonly prefix: Buffer,
  ) {}

  static async open(file: string, key: Buffer): Promise<SealedWriter> {
    const handle = await open(file, "wx", 0o600);
    const prefix = randomBytes(8);
    await handle.write(Buffer.concat([MAGIC, prefix]));
    return new SealedWriter(handle, key, prefix);
  }

  async write(data: Buffer): Promise<void> {
    this.pending = Buffer.concat([this.pending, data]);
    while (this.pending.length > CHUNK) {
      await this.seal(this.pending.subarray(0, CHUNK), false);
      this.pending = this.pending.subarray(CHUNK);
    }
  }

  async close(): Promise<void> {
    await this.seal(this.pending, true);
    await this.handle.sync();
    await this.handle.close();
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => {});
  }

  private async seal(plain: Buffer, last: boolean): Promise<void> {
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce(this.prefix, this.index++));
    cipher.setAAD(Buffer.from([last ? 1 : 0]));
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    await this.handle.write(sealed);
  }
}

class SealedReader {
  private buffer = Buffer.alloc(0);
  private index = 0;
  private done = false;
  private offset: number;

  private constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly key: Buffer,
    private readonly prefix: Buffer,
    private readonly size: number,
  ) {
    this.offset = MAGIC.length + 8;
  }

  static async open(file: string, key: Buffer): Promise<SealedReader> {
    const handle = await open(file, "r");
    const head = Buffer.alloc(MAGIC.length + 8);
    await handle.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
      await handle.close();
      throw new BackupError(`${file} is not a Nudge backup`);
    }
    return new SealedReader(handle, key, head.subarray(MAGIC.length), (await handle.stat()).size);
  }

  /** Exactly `length` more bytes of the plaintext. */
  async read(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      if (this.done) throw new BackupError("The backup ends early");
      await this.next();
    }
    const part = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return part;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private async next(): Promise<void> {
    const left = this.size - this.offset;
    const length = Math.min(left, CHUNK + TAG);
    if (length < TAG) throw new BackupError("The backup ends early");
    const sealed = Buffer.alloc(length);
    await this.handle.read(sealed, 0, length, this.offset);
    this.offset += length;
    const last = this.offset === this.size;
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce(this.prefix, this.index++));
    decipher.setAAD(Buffer.from([last ? 1 : 0]));
    decipher.setAuthTag(sealed.subarray(length - TAG));
    try {
      this.buffer = Buffer.concat([
        this.buffer,
        decipher.update(sealed.subarray(0, length - TAG)),
        decipher.final(),
      ]);
    } catch {
      throw new BackupError("Wrong backup key, or the backup is damaged");
    }
    this.done = last;
  }
}

function nonce(prefix: Buffer, index: number): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(index);
  return Buffer.concat([prefix, counter]);
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** Every file under `dir`, recursively; none when it doesn't exist. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function parseKey(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new BackupError(`${source} is not a base64 32-byte key`);
  return key;
}
