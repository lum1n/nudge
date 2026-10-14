import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Stored = Record<string, Record<string, string>>;

/**
 * Values an extension keeps for itself — API keys, passwords, tokens — that must never reach the
 * model. Kept per scope (usually a room id), encrypted at rest with AES-256-GCM under a key file
 * next to the store, or under `NUDGE_SECRETS_KEY` (base64, 32 bytes) when that is set. That keeps
 * them out of database copies and backups; whoever has the key can read them. Without a directory
 * (an in-memory assistant, or an extension with no `dataDir`), values live in memory only.
 *
 * One store per extension: `ExtensionHost.secrets`, under `<dataDir>/secrets`. The browser
 * extension's `LoginStore` predates this and is the pattern it follows; moving it over is a later
 * cleanup, not required.
 */
export class SecretStore {
  private readonly file: string | undefined;
  private readonly keyFile: string | undefined;
  private data: Stored | undefined;

  constructor(dir: string | undefined) {
    this.file = dir === undefined ? undefined : join(dir, "secrets.enc");
    this.keyFile = dir === undefined ? undefined : join(dir, "key");
    if (dir !== undefined) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get(scope: string, name: string): string | undefined {
    return this.load()[scope]?.[name];
  }

  /** The names set in `scope`, for listing without exposing values. */
  names(scope: string): string[] {
    return Object.keys(this.load()[scope] ?? {});
  }

  set(scope: string, name: string, value: string): void {
    const data = this.load();
    data[scope] = { ...data[scope], [name]: value };
    this.write(data);
  }

  /** False when `scope` had no secret with that name. */
  delete(scope: string, name: string): boolean {
    const data = this.load();
    if (data[scope]?.[name] === undefined) return false;
    const { [name]: _, ...rest } = data[scope]!;
    data[scope] = rest;
    this.write(data);
    return true;
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
    const fromEnv = process.env.NUDGE_SECRETS_KEY;
    if (fromEnv) {
      const key = Buffer.from(fromEnv.trim(), "base64");
      if (key.length !== 32) throw new Error("NUDGE_SECRETS_KEY is not a base64 32-byte key");
      return key;
    }
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

/**
 * Replaces every occurrence of `values` in `text` with `[secret]`. A last line of defence for tool
 * output and error messages that might otherwise echo a key or password back — not a substitute
 * for redaction, which runs on everything regardless. Empty values are ignored.
 */
export function scrubSecrets(text: string, values: readonly (string | undefined)[]): string {
  let out = text;
  for (const value of values) {
    if (value === undefined || value === "") continue;
    out = out.split(value).join("[secret]");
  }
  return out;
}
