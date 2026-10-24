import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { untrustedSources } from "./untrusted.ts";

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
  /** The entry the turn began with, to tell one turn from the next. */
  readonly start?: EntryId;
  /**
   * The sources of the untrusted data the turn has read so far, such as `mail_read`, or absent
   * when it read none. Calls that could send something out ask first while it is set (ADR 20).
   */
  readonly untrusted?: readonly string[];
  /**
   * The hosts the message the turn answers names, such as `nrk.no`: a page there wasn't chosen by
   * what the turn read. Absent for turns no person's message began.
   */
  readonly named?: readonly string[];
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
/** Pi Durable's `ToolResultEntry`: what a tool call gave the model. */
const TOOL_ENTRY = "pi.tool-result";

/** How far back a tool call looks for what it answers: an answer's own entries come between. */
const LOOK_BACK = 200;

/**
 * The turn a conversation is in now: what the newest message, fired nudge or approval outcome
 * says. A message someone sends while the answer runs starts a new turn, as it does in the timeline.
 * The untrusted data it read is what that input and the tool results since hold (ADR 20).
 */
export async function turnOf(
  harness: Pick<Harness, "conversation">,
  conversationId: ConversationId,
  context: Context,
): Promise<Turn> {
  const conversation = await harness.conversation(conversationId, context);
  if (conversation === undefined) return {};
  const page = await conversation.entries({}, LOOK_BACK, undefined, context);
  const read: string[] = [];
  const taken = (entry: EntryRecord, turn: Turn): Turn => {
    read.push(...untrustedSources(modelText(entry)));
    const untrusted = [...new Set(read.reverse())];
    return {
      ...turn,
      start: entry.id,
      ...(untrusted.length === 0 ? {} : { untrusted }),
    };
  };
  for (const entry of page.items) {
    if (entry.kind === "pi.user") return taken(entry, { named: hostsIn(modelText(entry)) });
    if (entry.kind === MESSAGE_ENTRY) {
      const data = entry.data as {
        playerId: string;
        displayName: string;
        private?: true;
      };
      const by = { playerId: data.playerId, displayName: data.displayName };
      const named = hostsIn(modelText(entry));
      return taken(entry, data.private === true ? { by, privateTo: by, named } : { by, named });
    }
    if (entry.kind === FIRE_ENTRY || entry.kind === APPROVAL_ENTRY) {
      const { privateTo } = entry.data as { privateTo?: Owner };
      return taken(entry, privateTo === undefined ? {} : { privateTo });
    }
    if (entry.kind === TOOL_ENTRY) read.push(...untrustedSources(modelText(entry)));
  }
  // A turn longer than the look-back still counts what it read in it.
  return read.length === 0 ? {} : { untrusted: [...new Set(read.reverse())] };
}

/** The text an entry gives the model. */
function modelText(entry: EntryRecord): string {
  return (entry.model ?? [])
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : ""))
        .join("\n");
    })
    .join("\n");
}

/** The hosts of the addresses in `text`, with or without a scheme, lower case. */
export function hostsIn(text: string): string[] {
  const hosts = [...text.matchAll(HOST)].map((match) => match[1]!.toLowerCase());
  return [...new Set(hosts.map((host) => host.replace(/^www\./, "")))];
}

const HOST = /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?![\w-])/gi;
