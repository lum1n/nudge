import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";

/** The player something private belongs to, with the name others are told it went to. */
export type Owner = { readonly playerId: string; readonly displayName: string };

/** What a tool call answers: a private message, nudge or approval makes everything it leads to private. */
export type Turn = {
  /** Who sent the message the turn answers; absent for fired nudges and approval outcomes. */
  readonly by?: Owner;
  /** Set when only this player may see what the turn shows and makes. */
  readonly privateTo?: Owner;
  /**
   * Personal values in `text` as placeholders, for what a tool stores, such as an approval's
   * summary. Absent outside tools.
   */
  readonly redact?: (text: string) => string;
};

/**
 * The input of a task that sets the turn of every tool call under it, such as a watch's script
 * run: those calls answer the watch, not whatever the room's conversation is in now. Only tasks
 * the assistant's own code creates can set it; a tool call's own task never does.
 */
export type SetsTurn = { readonly turn: { readonly privateTo?: Owner } };

const turns = new AsyncLocalStorage<Turn>();

/** The turn of the tool call running now; empty outside tools. */
export function currentTurn(): Turn {
  return turns.getStore() ?? {};
}

/** Runs `run` as part of `turn`, such as a tool call or an approved action. */
export function inTurn<T>(turn: Turn, run: () => T): T {
  return turns.run(turn, run);
}

// Entry kinds that start an answer, as in `room-events.ts`; repeated to keep this module light.
const MESSAGE_ENTRY = "nudge.message";
const FIRE_ENTRY = "nudge.fire";
const APPROVAL_ENTRY = "nudge.approval";

/** How far back a tool call looks for what it answers: an answer's own entries come between. */
const LOOK_BACK = 200;

/**
 * The turn a conversation is in now: what the newest message, fired nudge or approval outcome
 * says. A message someone sends while the answer runs starts a new turn, as it does in the timeline.
 */
export async function turnOf(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<Turn> {
  const conversation = await harness.conversation(conversationId, context);
  if (conversation === undefined) return {};
  const page = await conversation.entries({}, LOOK_BACK, undefined, context);
  for (const entry of page.items) {
    if (entry.kind === "pi.user") return {};
    if (entry.kind === MESSAGE_ENTRY) {
      const data = entry.data as {
        playerId: string;
        displayName: string;
        private?: true;
      };
      const by = { playerId: data.playerId, displayName: data.displayName };
      return data.private === true ? { by, privateTo: by } : { by };
    }
    if (entry.kind === FIRE_ENTRY || entry.kind === APPROVAL_ENTRY) {
      const { privateTo } = entry.data as { privateTo?: Owner };
      return privateTo === undefined ? {} : { privateTo };
    }
  }
  return {};
}
