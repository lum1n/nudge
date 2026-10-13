import { open, readFile, unlink } from "node:fs/promises";

export class DatabaseInUse extends Error {
  override name = "DatabaseInUse";
  constructor(
    readonly database: string,
    readonly pid: number,
  ) {
    super(`${database} is open in process ${pid}; stop it first, or talk to it with --url`);
  }
}

/**
 * Claims `database` for this process with a `<database>.lock` file holding the pid. Pi Durable
 * keeps state in memory, so a second process on the same file would never see the first's writes.
 * A lock left by a process that is gone is taken over. Resolves with the release.
 */
export async function lockDatabase(database: string): Promise<() => Promise<void>> {
  const path = `${database}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await open(path, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      return () => unlink(path).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
    }
    const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new DatabaseInUse(database, pid);
    await unlink(path).catch(() => {});
  }
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
