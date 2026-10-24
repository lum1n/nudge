import { createHash, createHmac } from "node:crypto";
import { existsSync, openAsBlob, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BackupError, backupNames, backupsBeyond, backupTime } from "./backup.ts";
import type { BackupRemoteConfig } from "./config.ts";
import { SecretStore } from "./secrets.ts";

/**
 * Off-site copies of backups (ADR 8): an S3-compatible bucket or a WebDAV folder. Backups are
 * sealed under the backup key before they leave, so the remote only ever holds ciphertext.
 */
export interface BackupRemote {
  /** Where the backups go, without credentials, for logs and the doctor. */
  readonly label: string;
  /** Stores `body` as `name`, replacing one of that name. */
  upload(name: string, body: Blob): Promise<void>;
  /** The backups there, oldest first. */
  list(): Promise<string[]>;
  /** Deletes `name`; one already gone is fine. */
  remove(name: string): Promise<void>;
}

/** An access key id and secret for S3, or a user name and password for WebDAV. */
export type RemoteCredentials = { readonly user: string; readonly secret: string };

/** How the last upload went, kept beside the credentials so the doctor and the apps can tell. */
export type RemoteState = {
  readonly lastUploadAt?: number;
  readonly lastFile?: string;
  readonly lastError?: string;
  readonly lastErrorAt?: number;
};

/** Where a server keeps its remote's credentials and state: `server/backup-remote`. */
export function backupRemoteDir(configPath: string): string {
  return join(dirname(resolve(configPath)), "server", "backup-remote");
}

const SCOPE = "remote";

/**
 * A server's remote backup target: its credentials, kept in a `SecretStore` like the model keys
 * (`NUDGE_BACKUP_REMOTE_USER` and `NUDGE_BACKUP_REMOTE_SECRET` win over it), and how the last
 * upload went.
 */
export class RemoteBackups {
  private readonly store: SecretStore;
  private readonly stateFile: string | undefined;

  /** `dir` is `backupRemoteDir(configPath)`; undefined keeps everything in memory, for tests. */
  constructor(
    dir: string | undefined,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.store = new SecretStore(dir);
    this.stateFile = dir === undefined ? undefined : join(dir, "state.json");
  }

  private memoryState: RemoteState = {};

  /** Where the credentials come from; undefined when there are none. */
  credentials(): (RemoteCredentials & { readonly from: "env" | "server" }) | undefined {
    const user = process.env.NUDGE_BACKUP_REMOTE_USER;
    const secret = process.env.NUDGE_BACKUP_REMOTE_SECRET;
    if (user && secret) return { user, secret, from: "env" };
    const stored = { user: this.store.get(SCOPE, "user"), secret: this.store.get(SCOPE, "secret") };
    if (stored.user === undefined || stored.secret === undefined) return undefined;
    return { user: stored.user, secret: stored.secret, from: "server" };
  }

  setCredentials(credentials: RemoteCredentials): void {
    this.store.set(SCOPE, "user", credentials.user);
    this.store.set(SCOPE, "secret", credentials.secret);
  }

  deleteCredentials(): void {
    this.store.delete(SCOPE, "user");
    this.store.delete(SCOPE, "secret");
  }

  /** The remote `config` names, with these credentials or the kept ones. */
  open(config: BackupRemoteConfig, credentials?: RemoteCredentials): BackupRemote {
    const found = credentials ?? this.credentials();
    if (config.type === "s3") {
      if (found === undefined)
        throw new BackupError("The S3 target has no access key: set one in the apps");
      return new S3Remote(config, found, this.fetcher);
    }
    return new WebDavRemote(config, found, this.fetcher);
  }

  state(): RemoteState {
    if (this.stateFile === undefined || !existsSync(this.stateFile)) return this.memoryState;
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as RemoteState;
    } catch {
      return {};
    }
  }

  private record(change: RemoteState): void {
    const next = { ...this.state(), ...change };
    this.memoryState = next;
    if (this.stateFile !== undefined)
      writeFileSync(this.stateFile, JSON.stringify(next), { mode: 0o600 });
  }

  /**
   * Uploads the backup `file`, then deletes all but the newest `keep` there, as the local folder
   * keeps them. Records how it went; throws when the upload failed.
   */
  async upload(
    config: BackupRemoteConfig,
    file: string,
    keep: number,
  ): Promise<{ readonly label: string; readonly deleted: string[] }> {
    let label = "the remote";
    try {
      const remote = this.open(config);
      label = remote.label;
      await remote.upload(basename(file), await openAsBlob(file));
      this.record({ lastUploadAt: Date.now(), lastFile: basename(file) });
      const deleted = backupsBeyond(await remote.list(), keep);
      for (const name of deleted) await remote.remove(name);
      return { label, deleted };
    } catch (error) {
      const message = (error as Error).message;
      this.record({ lastError: message, lastErrorAt: Date.now() });
      throw new BackupError(`Upload to ${label} failed: ${message}`);
    }
  }

  /**
   * Whether `config` works with these credentials: writes, lists and deletes a small file there.
   * Throws with what went wrong.
   */
  async check(config: BackupRemoteConfig, credentials?: RemoteCredentials): Promise<void> {
    const remote = this.open(config, credentials);
    const name = "nudge-check.txt";
    await remote.upload(name, new Blob(["Nudge checks it may write here.\n"]));
    await remote.list();
    await remote.remove(name);
  }
}

/** When the newest backup on `remote` was made; undefined when there is none. */
export async function lastRemoteBackupAt(remote: BackupRemote): Promise<Date | undefined> {
  const last = (await remote.list()).at(-1);
  return last === undefined ? undefined : backupTime(last);
}

// --- S3 -------------------------------------------------------------------------------------

/** The hex SHA-256 of an empty body, for requests without one. */
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

/**
 * The `Authorization` header for an AWS Signature Version 4 request. `headers` are the ones to
 * sign besides `host` (taken from the URL), with `x-amz-date` and `x-amz-content-sha256` among
 * them as S3 wants.
 */
export function signV4(options: {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly credentials: RemoteCredentials;
  readonly region: string;
  readonly service?: string;
  readonly now: Date;
}): string {
  const service = options.service ?? "s3";
  const stamp = amzDate(options.now);
  const day = stamp.slice(0, 8);
  const headers = new Map<string, string>([["host", options.url.host]]);
  for (const [name, value] of Object.entries(options.headers))
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  const names = [...headers.keys()].sort();
  const query = [...options.url.searchParams]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [
    options.method,
    options.url.pathname || "/",
    query,
    names.map((name) => `${name}:${headers.get(name)}\n`).join(""),
    names.join(";"),
    options.payloadHash,
  ].join("\n");
  const scope = `${day}/${options.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  let key: Buffer = hmac(`AWS4${options.credentials.secret}`, day);
  for (const part of [options.region, service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return (
    `AWS4-HMAC-SHA256 Credential=${options.credentials.user}/${scope}, ` +
    `SignedHeaders=${names.join(";")}, Signature=${signature}`
  );
}

/** `20130524T000000Z`, as SigV4 dates requests. */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

class S3Remote implements BackupRemote {
  readonly label: string;
  private readonly base: URL;
  private readonly prefix: string;
  private readonly region: string;

  constructor(
    config: Extract<BackupRemoteConfig, { type: "s3" }>,
    private readonly credentials: RemoteCredentials,
    private readonly fetcher: typeof fetch,
  ) {
    const endpoint = new URL(config.endpoint);
    const path = endpoint.pathname.replace(/\/+$/, "");
    const pathStyle = config.pathStyle ?? !endpoint.hostname.endsWith("amazonaws.com");
    this.base = pathStyle
      ? new URL(`${endpoint.origin}${path}/${encodeURIComponent(config.bucket)}/`)
      : new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}${path}/`);
    this.prefix = cleanPrefix(config.prefix);
    this.region =
      config.region ??
      /\bs3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(endpoint.hostname)?.[1] ??
      "us-east-1";
    this.label = `s3://${config.bucket}/${this.prefix}`;
  }

  async upload(name: string, body: Blob): Promise<void> {
    const hash = createHash("sha256");
    for await (const chunk of body.stream()) hash.update(chunk);
    await this.send("PUT", this.objectUrl(name), hash.digest("hex"), body);
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const url = new URL(this.base);
      url.searchParams.set("list-type", "2");
      if (this.prefix !== "") url.searchParams.set("prefix", this.prefix);
      if (token !== undefined) url.searchParams.set("continuation-token", token);
      const xml = await (await this.send("GET", url, EMPTY_SHA256)).text();
      for (const key of tags(xml, "Key"))
        if (key.startsWith(this.prefix)) names.push(key.slice(this.prefix.length));
      token =
        tags(xml, "IsTruncated")[0] === "true" ? tags(xml, "NextContinuationToken")[0] : undefined;
    } while (token !== undefined);
    return backupNames(names);
  }

  async remove(name: string): Promise<void> {
    await this.send("DELETE", this.objectUrl(name), EMPTY_SHA256, undefined, [404]);
  }

  private objectUrl(name: string): URL {
    const key = `${this.prefix}${name}`.split("/").map(rfc3986).join("/");
    return new URL(key, this.base);
  }

  private async send(
    method: string,
    url: URL,
    payloadHash: string,
    body?: Blob,
    alsoFine: readonly number[] = [],
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate(new Date()),
    };
    const authorization = signV4({
      method,
      url,
      headers,
      payloadHash,
      credentials: this.credentials,
      region: this.region,
      now: new Date(),
    });
    const response = await this.fetcher(url, {
      method,
      headers: { ...headers, authorization },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(body === undefined ? 30_000 : 30 * 60_000),
    });
    if (!response.ok && !alsoFine.includes(response.status)) {
      const text = await response.text().catch(() => "");
      const message = tags(text, "Message")[0] ?? tags(text, "Code")[0];
      throw new Error(
        `${method} ${url.pathname}: ${response.status}${message ? ` ${message}` : ""}`,
      );
    }
    return response;
  }
}

// --- WebDAV ---------------------------------------------------------------------------------

class WebDavRemote implements BackupRemote {
  readonly label: string;
  private readonly base: URL;
  private readonly authorization: string | undefined;

  constructor(
    config: Extract<BackupRemoteConfig, { type: "webdav" }>,
    credentials: RemoteCredentials | undefined,
    private readonly fetcher: typeof fetch,
  ) {
    const url = new URL(config.url);
    url.username = "";
    url.password = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    this.base = url;
    this.label = url.toString();
    this.authorization =
      credentials === undefined
        ? undefined
        : `Basic ${Buffer.from(`${credentials.user}:${credentials.secret}`).toString("base64")}`;
  }

  async upload(name: string, body: Blob): Promise<void> {
    const url = new URL(encodeURIComponent(name), this.base);
    let response = await this.send("PUT", url, { body });
    // The folder isn't there yet: make it, and its parents, then try once more.
    if (response.status === 409 || response.status === 404) {
      await this.makeFolders();
      response = await this.send("PUT", url, { body });
    }
    await expectOk(response, "PUT", url);
  }

  async list(): Promise<string[]> {
    const response = await this.send("PROPFIND", this.base, {
      headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
    });
    if (response.status === 404) return [];
    await expectOk(response, "PROPFIND", this.base);
    const names = tags(await response.text(), "href").map((href) => {
      const path = href.replace(/\/+$/, "");
      return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    });
    return backupNames(names);
  }

  async remove(name: string): Promise<void> {
    const url = new URL(encodeURIComponent(name), this.base);
    const response = await this.send("DELETE", url);
    if (response.status !== 404) await expectOk(response, "DELETE", url);
  }

  private async makeFolders(): Promise<void> {
    const parts = this.base.pathname.split("/").filter((part) => part !== "");
    for (let i = 1; i <= parts.length; i++) {
      const url = new URL(`/${parts.slice(0, i).join("/")}/`, this.base);
      const response = await this.send("MKCOL", url);
      // 405: it is there already.
      if (!response.ok && response.status !== 405) await expectOk(response, "MKCOL", url);
    }
  }

  private send(
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: Blob | string } = {},
  ): Promise<Response> {
    return this.fetcher(url, {
      method,
      headers: {
        ...init.headers,
        ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.body instanceof Blob ? 30 * 60_000 : 30_000),
    });
  }
}

async function expectOk(response: Response, method: string, url: URL): Promise<void> {
  if (response.ok || response.status === 207) return;
  const text = (await response.text().catch(() => "")).trim().slice(0, 200);
  throw new Error(`${method} ${url.pathname}: ${response.status}${text ? ` ${text}` : ""}`);
}

// --- Helpers --------------------------------------------------------------------------------

/** "" or a prefix ending in one "/", without a leading one. */
function cleanPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}

/** The text of every `<name>` element, whatever its namespace prefix, with entities decoded. */
function tags(xml: string, name: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${name}>`,
    "g",
  );
  return [...xml.matchAll(pattern)].map((match) =>
    match[1]!
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

/** URI-encodes as SigV4 wants: everything but `A-Za-z0-9-._~`. */
function rfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac("sha256", key).update(text).digest();
}
