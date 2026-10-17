import { dirname, join, resolve } from "node:path";
import {
  backupKey,
  createBackup,
  lastBackupAt,
  loadConfig,
  type NudgeConfig,
  pruneBackups,
  restoreBackup,
} from "@nudge/core";
import { UsageError } from "../errors.ts";

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
}

/** Unpacks a backup into a directory of its own; nothing running is touched. */
export async function restore(options: {
  readonly config: string;
  readonly file?: string;
  readonly to?: string;
  readonly force: boolean;
}): Promise<void> {
  if (options.file === undefined)
    throw new UsageError("restore needs a backup: nudge restore <file> --to <dir>");
  if (options.to === undefined)
    throw new UsageError("restore needs --to <dir>: an empty directory to unpack into");
  const config = await loadConfig(options.config).catch(() => undefined);
  const keyFile =
    config === undefined
      ? join(dirname(resolve(options.config)), "nudge-backup.key")
      : keyPath(options.config, config);
  const key = await backupKey(keyFile);
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
