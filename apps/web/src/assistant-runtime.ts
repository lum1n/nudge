import type {
  AppendMessage,
  ExternalThreadQueueAdapter,
  MessageStatus,
  QueueItemState,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { Part, PendingMessage, QueuedMessage, TimelineItem } from "@nudge/client";

/** A timeline item as the `ThreadMessageLike` assistant-ui renders; `me` is the player's id. */
export function toThreadMessageLike(item: TimelineItem, me: string): ThreadMessageLike {
  switch (item.type) {
    case "user":
      // Someone else's private message: the server sent it empty, so it is a line, not a bubble.
      if (item.privateTo !== undefined && item.text === "")
        return privateLine(item.id, `${item.privateTo.displayName} sent a private message`);
      return {
        id: item.id,
        role: "user",
        content: item.text,
        ...(item.sentAt === undefined ? {} : { createdAt: new Date(item.sentAt) }),
        ...(item.author === undefined
          ? {}
          : {
              metadata: {
                custom: {
                  author: item.author.displayName,
                  mine: item.author.id === me,
                  private: item.privateTo !== undefined,
                },
              },
            }),
      };
    // assistant-ui takes a system message with exactly one text part, so what kind of line it
    // is and its data ride along in `metadata.custom`.
    case "nudge":
      if (item.privateTo !== undefined && item.text === "")
        return privateLine(item.id, `A nudge for ${item.privateTo.displayName}`);
      return {
        id: item.id,
        role: "system",
        content: [{ type: "text", text: item.text }],
        createdAt: new Date(item.firedAt),
        metadata: { custom: { kind: "nudge", text: item.text } },
      };
    case "approval":
      if (item.privateTo !== undefined && item.summary === "")
        return privateLine(item.id, `An approval for ${item.privateTo.displayName} ended`);
      return {
        id: item.id,
        role: "system",
        content: [{ type: "text", text: `${item.approvalId} ${item.status}: ${item.summary}` }],
        metadata: {
          custom: {
            kind: "approval",
            id: item.approvalId,
            summary: item.summary,
            status: item.status,
            ...(item.decidedBy === undefined ? {} : { decidedBy: item.decidedBy }),
          },
        },
      };
    case "marker":
      return {
        id: item.id,
        role: "system",
        content: [{ type: "text", text: item.kind }],
        metadata: { custom: { kind: "marker", marker: item.kind } },
      };
    case "answer":
      if (item.privateTo !== undefined && item.privateTo.id !== me)
        return privateLine(
          item.id,
          item.status === "running"
            ? `Answering ${item.privateTo.displayName} privately…`
            : `Answered ${item.privateTo.displayName} privately`,
        );
      return {
        id: item.id,
        role: "assistant",
        // The tool parts' `args` is JSON from the model; cast past the index-signature mismatch
        // between our `unknown`-valued `Record` and assistant-ui's `ReadonlyJSONObject`.
        content: item.parts.map(toPart) as ThreadMessageLike["content"],
        status: toStatus(item),
        ...(item.privateTo === undefined ? {} : { metadata: { custom: { private: true } } }),
      };
  }
}

/** A line saying something private to someone else happened, without what. */
function privateLine(id: string, text: string): ThreadMessageLike {
  return {
    id,
    role: "system",
    content: [{ type: "text", text }],
    metadata: { custom: { kind: "private", text } },
  };
}

/** `⟦EMAIL1⟧` and the like: a value the server hid from this player. */
export const PLACEHOLDER = /⟦[A-Z]+\d+⟧/g;

function toPart(part: Part) {
  switch (part.type) {
    case "text":
      return { type: "text" as const, text: part.text };
    case "reasoning":
      return { type: "reasoning" as const, text: part.text };
    case "tool":
      return {
        type: "tool-call" as const,
        toolCallId: part.callId,
        toolName: part.name,
        args: part.args,
        argsText: JSON.stringify(part.args),
        ...(part.result === undefined ? {} : { result: part.result }),
        ...(part.isError === undefined ? {} : { isError: part.isError }),
        ...(part.details === undefined ? {} : { artifact: part.details }),
        // While it runs, what the tool says it is doing, such as browse's `Clicking "Search"…`.
        ...(part.result !== undefined || part.output === undefined
          ? {}
          : { artifact: { progress: progressLine(part.output) } }),
      };
  }
}

/** A running tool's current step: the last line of its output so far, cut short. */
export function progressLine(output: string): string | undefined {
  const line = output
    .split("\n")
    .map((text) => text.trim())
    .findLast((text) => text !== "");
  if (line === undefined) return undefined;
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

function toStatus(answer: Extract<TimelineItem, { type: "answer" }>): MessageStatus {
  switch (answer.status) {
    case "running":
      return { type: "running" };
    case "done":
      return { type: "complete", reason: "stop" };
    case "stopped":
      return { type: "incomplete", reason: "cancelled" };
    case "failed":
      return {
        type: "incomplete",
        reason: "error",
        ...(answer.error === undefined ? {} : { error: answer.error }),
      };
  }
}

function queueItem(id: string | number, text: string): QueueItemState {
  // Someone else's private message waits as an empty one.
  const shown = text === "" ? "A private message" : text;
  return { id: String(id), prompt: shown, parts: [{ type: "text", text: shown }] };
}

/** The text of a newly composed message, joining its text parts. */
export function appendText(message: AppendMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export type Lane = "queue" | "steer";

/**
 * The composer's queue: the room's queue (every player's waiting messages) plus this client's
 * sends the view doesn't show yet. Failed sends are left out; the room page offers them again.
 * `move`/`edit`/`remove` are no-ops: the server can't change or withdraw one queued message.
 */
export function buildQueueAdapter(
  queue: readonly QueuedMessage[],
  pending: readonly PendingMessage[],
  dispatch: (message: AppendMessage, lane: Lane) => void,
): ExternalThreadQueueAdapter {
  const items = (lane: Lane) => [
    ...queue
      .filter((item) => (item.mode === "steer" ? "steer" : "queue") === lane)
      .map((item) => queueItem(item.id, item.text)),
    ...pending
      .filter((item) => item.error === undefined)
      .filter((item) => (item.whenBusy === "steer" ? "steer" : "queue") === lane)
      .map((item) => queueItem(item.requestId, item.text)),
  ];
  return {
    items: items("queue"),
    steerItems: items("steer"),
    enqueue: (message) => dispatch(message, "queue"),
    steer: (message) => dispatch(message, "steer"),
    move: () => {},
    edit: () => {},
    remove: () => {},
  };
}
