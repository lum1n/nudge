import { findAssistant, LastOwner, loadConfig, ServerOwners, serverOwnersFile } from "@nudge/core";
import { UsageError } from "../errors.ts";

export type OwnerOptions = {
  readonly config: string;
  readonly assistant?: string;
  readonly verb?: string;
  /** A player id for add and token, an owner id for remove. */
  readonly id?: string;
};

/**
 * `nudge owner`: the server's owners (ADR 11), straight from its `server/owners.json`, so the
 * machine's own user can always add one, even while `nudge serve` runs.
 */
export async function owner(options: OwnerOptions): Promise<void> {
  const owners = new ServerOwners(serverOwnersFile(options.config));
  switch (options.verb) {
    case undefined:
    case "list": {
      const all = owners.list();
      if (all.length === 0)
        console.log("No owners yet: nudge owner add <player> makes a player an owner");
      for (const o of all) console.log(`${o.id}  ${o.playerId} of ${o.assistant}`);
      return;
    }
    case "add": {
      const playerId = need(options.id, "add needs a player id: nudge owner add <player>");
      const assistant = await assistantName(options);
      const added = owners.add(assistant, playerId);
      console.log(`${playerId} of ${assistant} is an owner of this server (${added.id}).`);
      return;
    }
    case "remove": {
      const id = need(options.id, "remove needs an owner id from nudge owner list");
      try {
        if (!owners.remove(id)) throw new UsageError(`No owner "${id}"`);
      } catch (error) {
        if (error instanceof LastOwner) throw new UsageError(error.message);
        throw error;
      }
      console.log(`Removed the owner ${id}.`);
      return;
    }
    case "token": {
      const playerId = need(options.id, "token needs a player id: nudge owner token <player>");
      const assistant = await assistantName(options);
      const found = owners.ownerOf(assistant, playerId);
      if (found === undefined)
        throw new UsageError(`${playerId} of ${assistant} is not an owner: nudge owner add first`);
      const { token, clientId } = owners.issue(found.id, { name: "nudge-cli", platform: "cli" });
      console.log(token);
      console.log(`(client ${clientId}; shown once. It works at /v1/server, as Bearer.)`);
      return;
    }
    default:
      throw new UsageError("Usage: nudge owner [list|add <player>|remove <id>|token <player>]");
  }
}

async function assistantName(options: OwnerOptions): Promise<string> {
  return findAssistant(await loadConfig(options.config), options.assistant).name;
}

function need(value: string | undefined, message: string): string {
  if (value === undefined) throw new UsageError(message);
  return value;
}
