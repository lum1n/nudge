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
  /**
   * Resubmitting with the same id after a crash or retry finds the first submission.
   * Scoped to the author's client, so one client's ids cannot collide with another's.
   */
  readonly requestId?: string;
  /** What happens when the room is mid-answer. Default `followUp`. */
  readonly whenBusy?: "steer" | "followUp" | "reject";
  /**
   * Only the author sees the message and the answer to it; the room's other members see that
   * there was one. Needs an author.
   */
  readonly private?: boolean;
};

export const MESSAGE_ENTRY = "nudge.message";

export type MessageEntryData = {
  readonly text: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly clientId?: string;
  /** The sender's own id for this message, so its client can match what it sent. */
  readonly requestId?: string;
  readonly sentAt: number;
  /** See `MessageDraft.private`. */
  readonly private?: true;
};

export async function submitMessage(
  harness: Harness,
  conversationId: ConversationId,
  draft: MessageDraft,
  now: number,
  timeZone: string,
  context: Context,
): Promise<Submission> {
  const conversation = await harness.conversation(conversationId, context);
  if (conversation === undefined) throw new Error(`No conversation ${conversationId}`);
  const { author, requestId } = draft;
  const secret = draft.private === true && author !== undefined;
  // The minute it was sent, so the model knows the time without a prompt that changes every minute.
  const sent = author === undefined ? "" : `${author.displayName} (${formatClock(now, timeZone)})`;
  return conversation.submit(
    {
      type: "input",
      content:
        author === undefined
          ? draft.text
          : secret
            ? `${sent} (privately: only ${author.displayName} sees this message and your answer to it; don't bring it up with anyone else): ${draft.text}`
            : `${sent}: ${draft.text}`,
      requestId:
        requestId === undefined || author?.clientId === undefined
          ? requestId
          : `${author.clientId}:${requestId}`,
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
                ...(requestId === undefined ? {} : { requestId }),
                sentAt: now,
                ...(secret ? { private: true as const } : {}),
              } satisfies MessageEntryData,
            },
    },
    context,
  );
}

/** The time of day, as "14:45". */
export function formatClock(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}

/** A snapshot of the conversation, then one batch of agent events per commit. */
export function attach(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<AgentEventStream> {
  return watchEvents(harness, conversationId, context);
}
