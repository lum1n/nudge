import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readlinkSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

/**
 * The project's release signing keys (Ed25519, SPKI DER, base64), newest first. A server installs
 * only a release whose manifest one of these signed; the private half is the repository's
 * NUDGE_RELEASE_KEY secret. A new key goes in front of the old, in a release the old one signed, so
 * servers out there follow it.
 */
export const RELEASE_KEYS: readonly string[] = [
  "MCowBQYDK2VwAyEAsWcxim6fEOyK/m9EArbjNyQdJQFDHapuHwak1BHsOtk=",
];

/** Where a server finds the newest release of its channel. */
export const RELEASE_MANIFEST_URL =
  "https://github.com/lum1n/nudge/releases/latest/download/manifest.json";

/** One release, as its manifest describes it. */
export type ReleaseManifest = {
  readonly nudge: "release";
  readonly version: string;
  readonly publishedAt: string;
  /** By platform, such as `linux-x64`. */
  readonly artifacts: Readonly<
    Record<string, { readonly url: string; readonly sha256: string; readonly size?: number }>
  >;
  /** Ed25519 over `canonicalJson` of the rest. */
  readonly signature: string;
};

/** What the server API shows of updates. */
export type UpdateState = {
  readonly current: string;
  /** False when the owner paused them, or the server wasn't started by `nudge-server`. */
  readonly automatic: boolean;
  readonly available?: string;
  readonly checkedAt?: number;
  readonly error?: string;
};

export class UpdateError extends Error {
  override name = "UpdateError";
}

/** A release's directory: its version, such as `0.2.0` or `0.3.0-beta.1`. */
const RELEASE_DIR = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Exit code that tells `nudge-server` to start the release `current` now points at. */
export const RESTART_EXIT_CODE = 75;

/**
 * JSON with keys sorted at every level, so a manifest signs and checks the same everywhere.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The manifest, if one of `keys` signed it; undefined otherwise. */
export function checkManifest(
  value: unknown,
  keys: readonly string[],
): ReleaseManifest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { signature, ...rest } = value as { signature?: unknown };
  if (typeof signature !== "string" || (rest as { nudge?: unknown }).nudge !== "release")
    return undefined;
  const signed = Buffer.from(canonicalJson(rest));
  const ok = keys.some((key) => {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      });
      return verify(null, signed, publicKey, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  });
  return ok ? (value as ReleaseManifest) : undefined;
}

/** Whether version `a` is newer than `b`: numeric parts compared in order, a pre-release older. */
export function newer(a: string, b: string): boolean {
  const parse = (version: string) => {
    const [main = "", pre] = version.replace(/^v/, "").split("-", 2);
    return { parts: main.split(".").map((part) => Number(part) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (x.pre === y.pre) return false;
  if (x.pre === undefined) return true;
  if (y.pre === undefined) return false;
  return x.pre > y.pre;
}

export type UpdatesOptions = {
  /** `$NUDGE_HOME/releases`, as `nudge-server` keeps it. */
  readonly releasesDir: string;
  /** The version running now. */
  readonly current: string;
  /** Such as `linux-x64`. */
  readonly platform: string;
  readonly manifestUrl?: string;
  readonly keys?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

/**
 * Self-update (ADR 11), for a server `nudge-server` started: finds a newer release the project
 * signed, downloads and checks it, unpacks it beside the running one, and points `current` at
 * it. `nudge-server` then starts it, and rolls it back if it fails before `confirm`.
 */
export class Updates {
  private available: ReleaseManifest | undefined;
  private checkedAt: number | undefined;
  private error: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: UpdatesOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  state(automatic: boolean): UpdateState {
    return {
      current: this.options.current,
      automatic,
      ...(this.available === undefined ? {} : { available: this.available.version }),
      ...(this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  /** The newest signed release, when it is newer than this one and hasn't failed here before. */
  async check(): Promise<ReleaseManifest | undefined> {
    this.checkedAt = this.now();
    try {
      const keys = this.options.keys ?? RELEASE_KEYS;
      if (keys.length === 0) throw new UpdateError("This build has no release key to check with");
      const response = await this.fetcher(this.options.manifestUrl ?? RELEASE_MANIFEST_URL, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new UpdateError(`The manifest answered ${response.status}`);
      const manifest = checkManifest(await response.json(), keys);
      if (manifest === undefined) throw new UpdateError("The manifest isn't signed by the project");
      this.error = undefined;
      const failed = await this.failed();
      this.available =
        newer(manifest.version, this.options.current) &&
        !failed.includes(manifest.version) &&
        manifest.artifacts[this.options.platform] !== undefined
          ? manifest
          : undefined;
      return this.available;
    } catch (error) {
      this.error = (error as Error).message;
      return undefined;
    }
  }

  /**
   * Downloads `release`, checks its hash, unpacks it into the releases directory and points
   * `current` at it, with `pending` naming this version to go back to. The caller then stops the
   * server with `RESTART_EXIT_CODE`.
   */
  async install(release: ReleaseManifest): Promise<void> {
    const artifact = release.artifacts[this.options.platform];
    if (artifact === undefined) throw new UpdateError(`No release for ${this.options.platform}`);
    const { releasesDir } = this.options;
    const target = join(releasesDir, release.version);
    const archive = `${target}.tar.gz`;
    const unpacking = `${target}.unpacking`;
    await mkdir(releasesDir, { recursive: true });
    await rm(unpacking, { recursive: true, force: true });
    const response = await this.fetcher(artifact.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || response.body === null)
      throw new UpdateError(`The release answered ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive));
    const hash = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    if (hash !== artifact.sha256) {
      await rm(archive, { force: true });
      throw new UpdateError("The release's hash isn't the one the manifest signed");
    }
    try {
      await mkdir(unpacking);
      await promisify(execFile)("tar", ["-xzf", archive, "-C", unpacking, "--strip-components=1"]);
      if (!existsSync(join(unpacking, "bin", "nudge-server")))
        throw new UpdateError("The release has no bin/nudge-server");
      await rm(target, { recursive: true, force: true });
      await rename(unpacking, target);
    } finally {
      await rm(archive, { force: true });
      await rm(unpacking, { recursive: true, force: true });
    }
    await writeFile(join(releasesDir, "pending"), this.options.current);
    const link = join(releasesDir, "current.next");
    await rm(link, { force: true });
    await symlink(release.version, link);
    await rename(link, join(releasesDir, "current"));
  }

  /** Whether this release is an update `nudge-server` would still roll back: not yet confirmed. */
  unconfirmed(): boolean {
    const { releasesDir, current } = this.options;
    if (!existsSync(join(releasesDir, "pending"))) return false;
    try {
      return readlinkSync(join(releasesDir, "current")) === current;
    } catch {
      return false;
    }
  }

  /**
   * Called once this release runs well: it stays, `pending` goes, and releases older than the
   * one before it are removed.
   */
  async confirm(): Promise<void> {
    const { releasesDir, current } = this.options;
    const pending = join(releasesDir, "pending");
    const previous = existsSync(pending) ? readFileSync(pending, "utf8").trim() : undefined;
    const pointed = await readlink(join(releasesDir, "current")).catch(() => undefined);
    if (pointed !== current) return;
    await rm(pending, { force: true });
    const keep = new Set([current, ...(previous === undefined ? [] : [previous])]);
    for (const entry of await readdir(releasesDir, { withFileTypes: true }).catch(() => [])) {
      // Release directories are named for their version; leave everything else alone.
      if (!entry.isDirectory() || keep.has(entry.name) || !RELEASE_DIR.test(entry.name)) continue;
      await rm(join(releasesDir, entry.name), { recursive: true, force: true });
    }
  }

  private async failed(): Promise<string[]> {
    const text = await readFile(join(this.options.releasesDir, "failed"), "utf8").catch(() => "");
    return text.split("\n").filter((line) => line !== "");
  }
}

export type ConfirmWhenHealthyOptions = {
  /** Whether the server answers well: its `GET /v1/health` says `ok`. */
  readonly probe: () => Promise<boolean>;
  /** `Updates.confirm`. */
  readonly confirm: () => Promise<void>;
  /** `Updates.unconfirmed`: whether giving up should roll this release back. */
  readonly unconfirmed: () => boolean;
  /** Stops the server with an error, so `nudge-server` rolls the release back. */
  readonly giveUp: () => void;
  readonly say: (line: string) => void;
  /** How long it runs before the first probe. */
  readonly afterMs?: number;
  /** Between probes. */
  readonly everyMs?: number;
  /** How long after starting it may take to answer well. */
  readonly withinMs?: number;
};

/**
 * Confirms this release once it has run `afterMs` and its health check answers well, so an update
 * that starts but doesn't serve is rolled back too, not only one that stops. An update still
 * unhealthy after `withinMs` gives up: the server stops with an error and `nudge-server` goes back
 * to the release before. Returns a function that stops waiting.
 */
export function confirmWhenHealthy(options: ConfirmWhenHealthyOptions): () => void {
  const afterMs = options.afterMs ?? 30_000;
  const everyMs = options.everyMs ?? 10_000;
  const withinMs = options.withinMs ?? 5 * 60_000;
  let waited = afterMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const attempt = async () => {
    if (stopped) return;
    if (await options.probe().catch(() => false)) {
      if (!stopped) await options.confirm().catch((error: Error) => options.say(error.message));
      return;
    }
    if (stopped) return;
    if (waited >= withinMs) {
      if (options.unconfirmed()) {
        options.say(`Not healthy ${Math.round(waited / 1000)} s after starting: rolling back`);
        options.giveUp();
      }
      return;
    }
    waited += everyMs;
    timer = setTimeout(() => void attempt(), everyMs);
  };
  timer = setTimeout(() => void attempt(), afterMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
