import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A login the user entered once in the live view and asked to remember. */
export type SavedLogin = {
  /** The host of the page the password was typed on; the login is only ever filled in there. */
  readonly host: string;
  readonly username?: string;
  readonly password: string;
  readonly savedAt: number;
};

type Stored = Record<string, SavedLogin[]>;

/**
 * Saved logins, per scope (a room), encrypted at rest with AES-256-GCM under a key file next to
 * them. That keeps them out of database copies and backups; whoever can read the key file can
 * read the logins. Without a directory, logins live in memory only.
 */
export class LoginStore {
  private readonly file: string | undefined;
  private readonly keyFile: string | undefined;
  private data: Stored | undefined;

  constructor(dir: string | undefined) {
    this.file = dir === undefined ? undefined : join(dir, "logins.enc");
    this.keyFile = dir === undefined ? undefined : join(dir, "key");
    if (dir !== undefined) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  list(scope: string): SavedLogin[] {
    return [...(this.load()[scope] ?? [])];
  }

  find(scope: string, host: string): SavedLogin | undefined {
    return this.load()[scope]?.find((login) => login.host === host);
  }

  save(scope: string, login: SavedLogin): void {
    const data = this.load();
    data[scope] = [...(data[scope] ?? []).filter((l) => l.host !== login.host), login];
    this.write(data);
  }

  forget(scope: string, host: string): boolean {
    const data = this.load();
    const before = data[scope]?.length ?? 0;
    data[scope] = (data[scope] ?? []).filter((l) => l.host !== host);
    this.write(data);
    return data[scope].length < before;
  }

  private load(): Stored {
    if (this.data !== undefined) return this.data;
    if (this.file === undefined || !existsSync(this.file)) return (this.data = {});
    const sealed = JSON.parse(readFileSync(this.file, "utf8")) as {
      iv: string;
      tag: string;
      data: string;
    };
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]);
    return (this.data = JSON.parse(plain.toString("utf8")) as Stored);
  }

  private write(data: Stored): void {
    this.data = data;
    if (this.file === undefined) return;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const sealed = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    const out = JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: sealed.toString("base64"),
    });
    writeFileSync(`${this.file}.tmp`, out, { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  private key(): Buffer {
    const file = this.keyFile!;
    if (!existsSync(file)) {
      try {
        writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
      } catch {
        // another writer made it first
      }
    }
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${file} is not a 32-byte key`);
    return key;
  }
}
