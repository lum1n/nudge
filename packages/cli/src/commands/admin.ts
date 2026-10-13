import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { findAssistant, loadConfig, type Nudge, openAssistant } from "@nudge/core";
import { describeNudge } from "../render.ts";

export type AdminOptions = {
  readonly config: string;
  readonly assistant?: string;
};

const context = BACKGROUND_CONTEXT;

/** Adds a player and prints their token, once. */
export async function invite(options: AdminOptions & { readonly name: string }): Promise<void> {
  await withAssistant(options, async (nudge) => {
    const { player, token } = await nudge.players.invite(options.name, context);
    console.log(`Invited ${player.displayName} as "${player.id}". Their token, shown only now:\n`);
    console.log(`  ${token}\n`);
    console.log("They connect with: NUDGE_TOKEN=<token> nudge chat --url <server>/a/<assistant>");
  });
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
