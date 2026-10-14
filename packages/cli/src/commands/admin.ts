import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { findAssistant, loadConfig, type Nudge, openAssistant } from "@nudge/core";
import { UsageError } from "../errors.ts";
import { describeNudge } from "../render.ts";

export type AdminOptions = {
  readonly config: string;
  readonly assistant?: string;
};

const context = BACKGROUND_CONTEXT;

/** Adds a player and prints their token, once, with a sign-in link for the web UI on `server`. */
export async function invite(
  options: AdminOptions & { readonly name: string; readonly server: string },
): Promise<void> {
  await withAssistant(options, async (nudge) => {
    const { player, token } = await nudge.players.invite(options.name, context);
    console.log(`Invited ${player.displayName} as "${player.id}". Their token, shown only now:\n`);
    console.log(`  ${token}\n`);
    console.log(`In a browser: ${new URL("/login", options.server).href}#token=${token}`);
    console.log("In a terminal: NUDGE_TOKEN=<token> nudge chat --url <server>/a/<assistant>");
  });
}

/** Prints a new token for an existing player, once; their other tokens keep working. */
export async function token(
  options: AdminOptions & { readonly player: string; readonly server: string },
): Promise<void> {
  await withAssistant(options, async (nudge) => {
    await knownPlayer(nudge, options.player);
    const issued = await nudge.players.issueToken(options.player, context);
    console.log(
      `New token for ${issued.player.displayName} (client ${issued.clientId}), shown only now:\n`,
    );
    console.log(`  ${issued.token}\n`);
    console.log(`In a browser: ${new URL("/login", options.server).href}#token=${issued.token}`);
    console.log(`Revoke it with: nudge revoke ${issued.clientId}`);
  });
}

/** Lists the tokens of one player, or of everyone, by client id and when they were issued. */
export async function tokens(options: AdminOptions & { readonly player?: string }): Promise<void> {
  await withAssistant(options, async (nudge) => {
    if (options.player !== undefined) await knownPlayer(nudge, options.player);
    const records = await nudge.players.tokens(options.player, context);
    if (records.length === 0) console.log("No tokens.");
    for (const record of records)
      console.log(
        `${record.playerId}\t${record.clientId}\t${new Date(record.createdAt).toISOString()}`,
      );
  });
}

/** Stops one client's token from signing in. */
export async function revoke(options: AdminOptions & { readonly clientId: string }): Promise<void> {
  await withAssistant(options, async (nudge) => {
    const known = await nudge.players.tokens(undefined, context);
    if (!known.some((record) => record.clientId === options.clientId))
      throw new UsageError(`No token for client "${options.clientId}"; see nudge tokens`);
    const record = await nudge.players.revoke(options.clientId, context);
    console.log(`Revoked ${record.playerId}'s token for client ${record.clientId}.`);
  });
}

async function knownPlayer(nudge: Nudge, id: string): Promise<void> {
  if ((await nudge.players.get(id, context)) !== undefined) return;
  const ids = (await nudge.players.list(context)).map((player) => player.id);
  throw new UsageError(`No player "${id}"; players: ${ids.join(", ") || "none"}`);
}

/** Creates a shared room, or lists the rooms without a name. */
export async function room(
  options: AdminOptions & { readonly name?: string; readonly members: readonly string[] },
): Promise<void> {
  await withAssistant(options, async (nudge) => {
    if (options.name === undefined) {
      for (const room of await nudge.rooms.list(context)) {
        const members = (await nudge.rooms.members(room.id, context)).map((p) => p.id);
        console.log(`${room.id}\t${room.kind}\t${room.name}\t${members.join(", ")}`);
      }
      return;
    }
    const created = await nudge.rooms.createShared(
      { name: options.name, members: options.members },
      context,
    );
    console.log(`Created room "${created.id}" for ${created.members.join(", ")}.`);
  });
}

/** Lists every pending nudge, with its room. */
export async function nudges(options: AdminOptions): Promise<void> {
  await withAssistant(options, async (nudge) => {
    const pending = await nudge.nudges.list(context);
    if (pending.length === 0) console.log("No nudges scheduled.");
    for (const scheduled of pending)
      console.log(`${scheduled.roomId}\t${describeNudge(scheduled)}`);
  });
}

/**
 * Asks the process that has each assistant open (`nudge serve`, or an in-process `nudge chat`) to
 * reinstall its extensions from the config. False when none is running.
 */
export async function reload(options: AdminOptions): Promise<boolean> {
  const config = await loadConfig(options.config);
  const assistants =
    options.assistant === undefined
      ? config.assistants
      : [findAssistant(config, options.assistant)];
  const signalled = new Set<number>();
  for (const assistant of assistants) {
    const lock = `${assistant.database}.lock`;
    const pid = Number((await readFile(lock, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      console.log(`${assistant.name}: not running`);
      continue;
    }
    if (!signalled.has(pid)) {
      try {
        process.kill(pid, "SIGHUP");
      } catch (error) {
        console.log(`${assistant.name}: process ${pid} is gone (${(error as Error).message})`);
        continue;
      }
      signalled.add(pid);
    }
    console.log(`${assistant.name}: asked process ${pid} to reload; it prints the result`);
  }
  return signalled.size > 0;
}

async function withAssistant(
  options: AdminOptions,
  use: (nudge: Nudge) => Promise<void>,
): Promise<void> {
  const config = await loadConfig(options.config);
  const nudge = await openAssistant(config, findAssistant(config, options.assistant), context);
  try {
    await use(nudge);
  } finally {
    await nudge.close(context);
  }
}
