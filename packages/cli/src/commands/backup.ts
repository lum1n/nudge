import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  BackupError,
  type BackupSettings,
  backupKey,
  backupRemoteDir,
  createBackup,
  lastBackupAt,
  loadConfig,
  type NudgeConfig,
  openRecoveryKit,
  parseConfig,
  pruneBackups,
  readRawConfig,
  type RemoteCredentials,
  RemoteBackups,
  restoreBackup,
  writeRawConfig,
} from "@nudge/core";
import type { BackupState } from "@nudge/protocol";
import type { BackupControl } from "@nudge/server";
import { UsageError } from "../errors.ts";
import { promptHidden } from "./setup.ts";

/** Where the backup key lives unless NUDGE_BACKUP_KEY is set. */
export function keyPath(configPath: string, config: NudgeConfig): string {
  return config.backup?.keyFile ?? join(dirname(resolve(configPath)), "nudge-backup.key");
}

/** Makes one encrypted backup now, into `--to` or the config's `backup.dir`. */
export async function backup(options: {
  readonly config: string;
  readonly to?: string;
}): Promise<void> {
  const config = await loadConfig(options.config);
  const dir = options.to === undefined ? config.backup?.dir : resolve(options.to);
  if (dir === undefined)
    throw new UsageError('Where to? Give --to <dir>, or set "backup": { "dir": … } in the config');
  const keyFile = keyPath(options.config, config);
  const hadKey = process.env.NUDGE_BACKUP_KEY !== undefined || (await exists(keyFile));
  const key = await backupKey(keyFile, true);
  if (!hadKey)
    console.log(
      `Made a backup key in ${keyFile}. Without it no backup can be read: keep a copy somewhere ` +
        "other than this machine and the backups (a password manager, a printout).",
    );
  const file = await createBackup({ configPath: options.config, config, dir, key });
  console.log(`Backed up to ${file}`);
  const keep = config.backup?.keep;
  if (keep !== undefined && options.to === undefined)
    for (const old of await pruneBackups(dir, keep)) console.log(`Deleted the old backup ${old}`);
  if (options.to === undefined && config.backup?.remote !== undefined)
    await uploadBackup(options.config, config.backup, file, (line) => console.log(line));
}

/**
 * Copies a backup just made to the config's remote target, if it has one, and deletes the oldest
 * there past `keep`, as in the folder. Throws when the upload fails; the local copy stays.
 */
export async function uploadBackup(
  configPath: string,
  settings: BackupSettings,
  file: string,
  log: (line: string) => void,
  remotes = new RemoteBackups(backupRemoteDir(configPath)),
): Promise<void> {
  if (settings.remote === undefined) return;
  const { label, deleted } = await remotes.upload(settings.remote, file, settings.keep ?? 14);
  log(`Uploaded it to ${label}`);
  for (const name of deleted) log(`Deleted the old backup ${name} from ${label}`);
}

/** What a server set up in the wizard backs up, and what the apps turn on with a remote target. */
const DEFAULT_BACKUP = { dir: "backups", everyHours: 24, keep: 14 };

/**
 * The server API's backups (ADR 8) for `nudge serve`: their state, the remote target owners set
 * in the apps, and a backup now. `changed` runs after the config is written, to reload it and
 * reschedule.
 */
export function backupControl(
  configPath: string,
  changed: () => Promise<void>,
  remotes = new RemoteBackups(backupRemoteDir(configPath)),
): BackupControl {
  const state = async (): Promise<BackupState> => {
    const settings = (await loadConfig(configPath)).backup;
    const last = settings === undefined ? undefined : await lastBackupAt(settings.dir);
    const credentials = settings?.remote === undefined ? undefined : remotes.credentials();
    const upload = settings?.remote === undefined ? {} : remotes.state();
    return {
      on: settings !== undefined,
      ...(settings === undefined ? {} : { dir: settings.dir }),
      everyHours: settings?.everyHours ?? DEFAULT_BACKUP.everyHours,
      keep: settings?.keep ?? DEFAULT_BACKUP.keep,
      ...(last === undefined ? {} : { lastBackupAt: last.getTime() }),
      ...(settings?.remote === undefined ? {} : { remote: settings.remote }),
      ...(credentials === undefined
        ? {}
        : { credentials: { user: credentials.user, from: credentials.from } }),
      ...(upload.lastUploadAt === undefined ? {} : { lastUploadAt: upload.lastUploadAt }),
      ...(upload.lastError === undefined || (upload.lastErrorAt ?? 0) < (upload.lastUploadAt ?? 0)
        ? {}
        : { lastError: upload.lastError, lastErrorAt: upload.lastErrorAt! }),
    };
  };
  const writeBackup = async (change: (backup: Record<string, unknown>) => void) => {
    const raw = await readRawConfig(configPath);
    const backup = { ...((raw.backup as Record<string, unknown> | undefined) ?? DEFAULT_BACKUP) };
    change(backup);
    raw.backup = backup;
    // Refused before it is written, so a bad target never stops the server from starting.
    parseConfig(raw, dirname(resolve(configPath)));
    await writeRawConfig(configPath, raw);
    await changed();
  };
  return {
    state,
    setRemote: async ({ user, secret, test, ...target }) => {
      const kept = remotes.credentials();
      let credentials: RemoteCredentials | undefined;
      if (secret !== undefined && secret !== "") {
        if (!user)
          throw new BackupError(
            target.type === "s3"
              ? "Give the access key id with its secret"
              : "Give the user name with the password",
          );
        credentials = { user, secret };
      } else if (kept !== undefined) credentials = { user: user || kept.user, secret: kept.secret };
      if (target.type === "s3" && credentials === undefined)
        throw new BackupError("An S3 bucket needs an access key id and its secret");
      if (test !== false)
        await remotes.check(target, credentials).catch((error: unknown) => {
          throw new BackupError(`Nudge couldn't write there: ${(error as Error).message}`);
        });
      await writeBackup((backup) => (backup.remote = target));
      if (credentials !== undefined && (secret || kept?.from === "server"))
        remotes.setCredentials(credentials);
      return state();
    },
    removeRemote: async () => {
      await writeBackup((backup) => delete backup.remote);
      remotes.deleteCredentials();
      return state();
    },
    backUpNow: async () => {
      const config = await loadConfig(configPath);
      const settings = config.backup;
      if (settings === undefined)
        throw new BackupError('This server makes no backups: set "backup" in its nudge.json');
      const key = await backupKey(keyPath(configPath, config), true);
      const file = await createBackup({ configPath, config, dir: settings.dir, key });
      await pruneBackups(settings.dir, settings.keep ?? DEFAULT_BACKUP.keep);
      try {
        await uploadBackup(configPath, settings, file, () => {}, remotes);
        return { file: basename(file) };
      } catch (error) {
        return { file: basename(file), uploadError: (error as Error).message };
      }
    },
  };
}

/** Unpacks a backup into a directory of its own; nothing running is touched. */
export async function restore(options: {
  readonly config: string;
  readonly file?: string;
  readonly to?: string;
  readonly force: boolean;
  /** A recovery kit to take the backup key from, as on a new machine. */
  readonly kit?: string;
}): Promise<void> {
  if (options.file === undefined)
    throw new UsageError("restore needs a backup: nudge restore <file> --to <dir>");
  if (options.to === undefined)
    throw new UsageError("restore needs --to <dir>: an empty directory to unpack into");
  let key: Buffer;
  if (options.kit !== undefined) {
    const passphrase = await promptHidden(`Passphrase of ${options.kit}`);
    try {
      key = openRecoveryKit(await readFile(options.kit, "utf8"), passphrase);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  } else {
    const config = await loadConfig(options.config).catch(() => undefined);
    const keyFile =
      config === undefined
        ? join(dirname(resolve(options.config)), "nudge-backup.key")
        : keyPath(options.config, config);
    key = await backupKey(keyFile);
  }
  const manifest = await restoreBackup({
    file: options.file,
    key,
    dir: options.to,
    force: options.force,
  });
  console.log(
    `Restored ${manifest.files.length} files of ${manifest.assistants.join(", ")} from ${manifest.createdAt} into ${resolve(options.to)}.`,
  );
  console.log(
    "Start Nudge there with its nudge.json (nudge serve -c <dir>/nudge.json), or stop the running " +
      "one and copy the files over. Files from outside the config's directory are under external/.",
  );
}

/**
 * Makes a backup every `backup.everyHours` while `nudge serve` runs, the first once the last one
 * is that old. Returns a function that stops it.
 */
export function scheduleBackups(
  configPath: string,
  config: NudgeConfig,
  log: (line: string) => void,
): () => void {
  const settings = config.backup;
  if (settings === undefined) return () => {};
  const every = (settings.everyHours ?? 24) * 3_600_000;
  const keep = settings.keep ?? 14;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = async () => {
    try {
      const key = await backupKey(keyPath(configPath, config));
      const file = await createBackup({ configPath, config, dir: settings.dir, key });
      await pruneBackups(settings.dir, keep);
      log(`Backed up to ${file}`);
      // The local copy is made; a remote that is down is tried again with the next one.
      await uploadBackup(configPath, settings, file, log).catch((error: unknown) =>
        log((error as Error).message),
      );
    } catch (error) {
      log(`Backup failed: ${(error as Error).message}`);
    }
    if (!stopped) timer = setTimeout(() => void run(), every);
  };
  void lastBackupAt(settings.dir).then((last) => {
    if (stopped) return;
    const wait =
      last === undefined ? 60_000 : Math.max(60_000, last.getTime() + every - Date.now());
    timer = setTimeout(() => void run(), wait);
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function exists(file: string): Promise<boolean> {
  return (await import("node:fs/promises")).access(file).then(
    () => true,
    () => false,
  );
}
