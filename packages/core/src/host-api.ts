import type { Context } from "@earendil-works/chord";
import {
  type AgentEventStream,
  type ConversationId,
  type Harness,
  type Submission,
  watchEvents,
} from "@earendil-works/pi-durable";

/** Who wrote a message. Stored with the entry; the model only sees the display name. */
export type Author = {
  readonly playerId: string;
  readonly displayName: string;
  readonly clientId?: string;
};

export type MessageDraft = {
  readonly text: string;
  readonly author?: Author;
  /** Resubmitting with the same id after a crash or retry finds the first submission. */
  readonly requestId?: string;
  /** What happens when the room is mid-answer. Default `followUp`. */
  readonly whenBusy?: "steer" | "followUp" | "reject";
};

export const MESSAGE_ENTRY = "nudge.message";

export type MessageEntryData = {
  readonly text: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly clientId?: string;
  readonly sentAt: number;
};

export async function submitMessage(
  harness: Harness,
  conversationId: ConversationId,
  draft: MessageDraft,
  now: number,
  context: Context,
): Promise<Submission> {
  const conversation = await harness.conversation(conversationId, context);
  if (conversation === undefined) throw new Error(`No conversation ${conversationId}`);
  const { author } = draft;
  return conversation.submit(
    {
      type: "input",
      content: author === undefined ? draft.text : `${author.displayName}: ${draft.text}`,
      requestId: draft.requestId,
      whenBusy: draft.whenBusy ?? "followUp",
      entry:
        author === undefined
          ? undefined
          : {
              kind: MESSAGE_ENTRY,
              data: {
                text: draft.text,
                playerId: author.playerId,
                displayName: author.displayName,
                ...(author.clientId === undefined ? {} : { clientId: author.clientId }),
                sentAt: now,
              } satisfies MessageEntryData,
            },
    },
    context,
  );
}

/** A snapshot of the conversation, then one batch of agent events per commit. */
export function attach(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<AgentEventStream> {
  return watchEvents(harness, conversationId, context);
}
