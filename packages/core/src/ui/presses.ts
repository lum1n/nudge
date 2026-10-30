import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  type Cursor,
  defineDocFamily,
  type EntryRecord,
  type Harness,
  type Submission,
} from "@earendil-works/pi-durable";
import type { Author, MessageDraft } from "../host-api.ts";
import type { Rooms } from "../identity/rooms.ts";
import type { Owner } from "../privacy/turn.ts";
import {
  cardOf,
  cardProblem,
  pressText,
  type UiCard,
  UI_CARD_MAX_CHARS,
  type UiValues,
} from "./card.ts";

// Entry kinds, as in `privacy/turn.ts`.
const MESSAGE_ENTRY = "nudge.message";
const FIRE_ENTRY = "nudge.fire";
const APPROVAL_ENTRY = "nudge.approval";
const TOOL_ENTRY = "pi.tool-result";
/** A card shown again with new content (ADR 30); the projection draws the latest. */
export const UI_UPDATE_ENTRY = "nudge.ui-update";

/** What a `nudge.ui-update` entry holds. */
export type UiUpdateEntryData = { readonly callId: string; readonly card: UiCard };

/** How many entries back a press looks for its card; older cards can't be pressed. */
const LOOK_BACK = 5000;
const PAGE = 500;

type Press = { by: string; button: string; at: number };

/** Each conversation's pressed cards, by tool call id, so a card that works once does. */
export const UiPressesDoc = defineDocFamily<{ pressed: Record<string, Press> }, null>({
  kind: "nudge.ui-presses",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ pressed: {} }),
});

/** No card there for the caller: unknown, too old, or private to someone else. */
export class UiCardNotFound extends Error {
  override name = "UiCardNotFound";
  constructor(readonly callId: string) {
    super(`No card "${callId}"`);
  }
}

/** The card works once and was pressed already. */
export class UiCardPressed extends Error {
  override name = "UiCardPressed";
  constructor(readonly callId: string) {
    super(`Card "${callId}" was pressed already`);
  }
}

/** Only who the answer was for may press the card. */
export class UiNotYours extends Error {
  override name = "UiNotYours";
  constructor(readonly callId: string) {
    super(`Only who it was shown for may press card "${callId}"`);
  }
}

/** A card that can't be shown, with why. */
export class UiCardInvalid extends Error {
  override name = "UiCardInvalid";
}

/** A card as a room shows it, and who it was for. */
export type FoundCard = {
  readonly card: UiCard;
  /** Only this player sees it, since the answer it is in is theirs. */
  readonly privateTo?: Owner;
  /** Who sent the message its answer is to, when a player did. */
  readonly askedBy?: Owner;
};

export type PressDraft = {
  readonly by: Author;
  readonly button: string;
  readonly values?: UiValues;
  /** As for a message: the same id again finds the first press. */
  readonly requestId?: string;
};

/** Presses on the cards tools show (ADR 27): each becomes a message from whoever pressed. */
export class UiPresses {
  constructor(
    private readonly harness: Pick<Harness, "conversation" | "commit">,
    private readonly rooms: Pick<Rooms, "get">,
    private readonly now: () => number,
    private readonly submit: (
      roomId: string,
      draft: MessageDraft,
      context: Context,
    ) => Promise<Submission>,
  ) {}

  /** The card a tool call showed in a room, as its latest update has it, if it is there and valid. */
  async find(roomId: string, callId: string, context: Context): Promise<FoundCard | undefined> {
    const room = await this.rooms.get(roomId, context);
    if (room === undefined) return undefined;
    return this.findIn(room.conversationId as ConversationId, callId, context);
  }

  private async findIn(
    conversationId: ConversationId,
    callId: string,
    context: Context,
  ): Promise<FoundCard | undefined> {
    const conversation = await this.harness.conversation(conversationId, context);
    if (conversation === undefined) return undefined;
    let card: UiCard | undefined;
    // The newest update comes first, reading from the end.
    let updated: UiCard | undefined;
    let cursor: Cursor | undefined;
    let read = 0;
    do {
      const page = await conversation.entries({}, PAGE, cursor, context);
      for (const entry of page.items) {
        if (card === undefined) {
          if (updated === undefined && entry.kind === UI_UPDATE_ENTRY) {
            const data = entry.data as UiUpdateEntryData;
            if (data.callId === callId) updated = cardOf({ ui: data.card });
          } else if (entry.kind === TOOL_ENTRY && resultOf(entry)?.toolCallId === callId) {
            const shown = cardOf(resultOf(entry)?.details);
            if (shown === undefined) return undefined;
            card = updated ?? shown;
          }
          continue;
        }
        // The answer the card is in starts at the newest message, nudge or approval above it.
        const start = answerStart(entry);
        if (start !== undefined) return { card, ...start };
      }
      read += page.items.length;
      cursor = page.next;
    } while (cursor !== undefined && read < LOOK_BACK);
    return card === undefined ? undefined : { card };
  }

  /**
   * Shows the card tool call `callId` showed in a conversation again with `card` (ADR 30), such as
   * a delivery's next step or a price that fell. It starts over: its buttons work again. Throws
   * `UiCardNotFound` when there is no card there, and `UiCardInvalid` for a card that can't be
   * shown. The model doesn't see it; tell it in a tool result when it should know.
   */
  async update(
    conversationId: ConversationId,
    callId: string,
    card: UiCard,
    context: Context,
  ): Promise<void> {
    const size = JSON.stringify(card).length;
    const problem =
      cardProblem(card) ??
      (size > UI_CARD_MAX_CHARS
        ? `it is ${size} characters as JSON, over ${UI_CARD_MAX_CHARS}`
        : undefined);
    if (problem !== undefined) throw new UiCardInvalid(problem);
    if ((await this.findIn(conversationId, callId, context)) === undefined)
      throw new UiCardNotFound(callId);
    const conversation = await this.harness.conversation(conversationId, context);
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(UiPressesDoc, String(conversationId), null);
      delete state.pressed[callId];
    }, context);
    await conversation!.submit(
      {
        type: "write",
        entry: { kind: UI_UPDATE_ENTRY, data: { callId, card } satisfies UiUpdateEntryData },
      },
      context,
    );
  }

  /**
   * Presses a button on a card: checks the caller may, that a card that works once wasn't pressed,
   * and the values; then posts the press to the room as `by`'s message. Checking that `by` may use
   * the room is the host's job.
   */
  async press(
    roomId: string,
    callId: string,
    draft: PressDraft,
    context: Context,
  ): Promise<Submission> {
    const found = await this.find(roomId, callId, context);
    const playerId = draft.by.playerId;
    if (found === undefined) throw new UiCardNotFound(callId);
    if (found.privateTo !== undefined && found.privateTo.playerId !== playerId)
      throw new UiCardNotFound(callId);
    if (found.card.who === "asker" && found.askedBy?.playerId !== playerId)
      throw new UiNotYours(callId);
    const text = pressText(found.card, draft.button, draft.values);
    const room = await this.rooms.get(roomId, context);
    const key = String(room!.conversationId);
    const once = found.card.once !== false;
    // Marked first, in one commit, so two people pressing at once can't both get through.
    const before = await this.harness.commit(async (tx) => {
      const state = await tx.doc(UiPressesDoc, key, null);
      const earlier = state.pressed[callId];
      if (once && earlier !== undefined) throw new UiCardPressed(callId);
      state.pressed[callId] = { by: playerId, button: draft.button, at: this.now() };
      return earlier;
    }, context);
    try {
      return await this.submit(
        roomId,
        {
          text,
          author: draft.by,
          ...(draft.requestId === undefined ? {} : { requestId: draft.requestId }),
          // A card in a private answer is pressed privately too.
          ...(found.privateTo === undefined ? {} : { private: true }),
          press: { callId, button: draft.button },
        },
        context,
      );
    } catch (error) {
      await this.harness.commit(async (tx) => {
        const state = await tx.doc(UiPressesDoc, key, null);
        if (before === undefined) delete state.pressed[callId];
        else state.pressed[callId] = before;
      }, context);
      throw error;
    }
  }
}

type ToolResult = { role: "toolResult"; toolCallId: string; details?: unknown };

function resultOf(entry: EntryRecord): ToolResult | undefined {
  return entry.model?.find((message) => message.role === "toolResult") as ToolResult | undefined;
}

/** Who the answer an entry starts is for, when it starts one. */
function answerStart(entry: EntryRecord): { privateTo?: Owner; askedBy?: Owner } | undefined {
  if (entry.kind === "pi.user") return {};
  if (entry.kind === MESSAGE_ENTRY) {
    const data = entry.data as { playerId: string; displayName: string; private?: true };
    const by = { playerId: data.playerId, displayName: data.displayName };
    return data.private === true ? { privateTo: by, askedBy: by } : { askedBy: by };
  }
  if (entry.kind === FIRE_ENTRY || entry.kind === APPROVAL_ENTRY) {
    // A public nudge was for whoever scheduled it.
    const { privateTo, scheduledBy } = entry.data as { privateTo?: Owner; scheduledBy?: Owner };
    const askedBy = privateTo ?? scheduledBy;
    return {
      ...(privateTo === undefined ? {} : { privateTo }),
      ...(askedBy === undefined ? {} : { askedBy }),
    };
  }
  return undefined;
}
