import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export class DatabaseInUse extends Error {
  override name = "DatabaseInUse";
  constructor(
    readonly database: string,
    readonly pid: number,
  ) {
    super(`${database} is open in process ${pid}; stop it first, or talk to it with --url`);
  }
}

/** Lock files this process holds, so a second open in the same process is still refused. */
const held = new Map<string, symbol>();

/**
 * Claims `database` for this process with a `<database>.lock` file holding the pid. Pi Durable
 * keeps state in memory, so a second process on the same file would never see the first's writes.
 * A lock left by a process that is gone is taken over, and so is one holding our own pid that this
 * process didn't take: in a container the server gets the same pid every start, so that lock is
 * from a run that crashed or was killed. Resolves with the release.
 */
export async function lockDatabase(database: string): Promise<() => Promise<void>> {
  const path = resolve(`${database}.lock`);
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await open(path, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      const claim = Symbol(path);
      held.set(path, claim);
      return async () => {
        if (held.get(path) !== claim) return;
        held.delete(path);
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
    }
    const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (pid === process.pid ? held.has(path) : Number.isInteger(pid) && pid > 0 && alive(pid))
      throw new DatabaseInUse(database, pid);
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
