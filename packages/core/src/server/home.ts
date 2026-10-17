import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The server's data directory: its `nudge.json`, the assistants' databases and their data, and
 * `server/` with the master key. `NUDGE_HOME` when set (the image sets `/data`), else the
 * platform's place for application data.
 */
export function serverHome(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.NUDGE_HOME) return resolve(env.NUDGE_HOME);
  if (platform === "darwin") return join(home, "Library", "Application Support", "Nudge");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "nudge");
}

/**
 * The config file a command uses without `-c`: the data directory's when `NUDGE_HOME` is set,
 * else a `nudge.json` in the working directory if there is one (a checkout, as before there was
 * a data directory), else the data directory's.
 */
export function defaultConfigPath(
  env: Env = process.env,
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (!env.NUDGE_HOME) {
    const here = join(cwd, "nudge.json");
    if (existsSync(here)) return here;
  }
  return join(serverHome(env, platform, home), "nudge.json");
}
