import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { findAssistant, loadConfig, type Nudge, openAssistant } from "@nudge/core";

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
