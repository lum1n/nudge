import type {
  AppendMessage,
  ExternalThreadQueueAdapter,
  MessageStatus,
  QueueItemState,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { AssistantPart, QueuedMessage, ThreadMessage } from "./thread.ts";

/** A `ThreadMessage` (from `thread.ts`) as the `ThreadMessageLike` assistant-ui renders. */
export function toThreadMessageLike(message: ThreadMessage): ThreadMessageLike {
  switch (message.role) {
    case "user":
      return {
        id: message.id,
        role: "user",
        content: message.text,
        ...(message.sentAt === undefined ? {} : { createdAt: new Date(message.sentAt) }),
        ...(message.author === undefined
          ? {}
          : {
              metadata: {
                custom: { author: message.author.displayName, mine: message.mine },
              },
            }),
      };
    case "nudge":
      return {
        id: message.id,
        role: "system",
        content: [{ type: "data-nudge", data: { text: message.text } }],
        createdAt: new Date(message.firedAt),
      };
    case "marker":
      return {
        id: message.id,
        role: "system",
        content: [{ type: "data-marker", data: { kind: message.kind } }],
      };
    case "assistant":
      return {
        id: message.id,
        role: "assistant",
        // The tool-call parts' `args` is JSON from the model; cast past the index-signature
        // mismatch between our `unknown`-valued `Record` and assistant-ui's `ReadonlyJSONObject`.
        content: message.parts.map(toPart) as ThreadMessageLike["content"],
        status: toStatus(message),
      };
  }
}

function toPart(part: AssistantPart) {
  switch (part.type) {
    case "text":
      return { type: "text" as const, text: part.text };
    case "reasoning":
      return { type: "reasoning" as const, text: part.text };
    case "tool-call":
      return {
        type: "tool-call" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
        argsText: JSON.stringify(part.args),
        ...(part.result === undefined ? {} : { result: part.result }),
        ...(part.isError === undefined ? {} : { isError: part.isError }),
        ...(part.details === undefined ? {} : { artifact: part.details }),
      };
  }
}

function toStatus(message: Extract<ThreadMessage, { role: "assistant" }>): MessageStatus {
  switch (message.status) {
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
        ...(message.error === undefined ? {} : { error: message.error }),
      };
  }
}

function queueItem(id: string | number, text: string): QueueItemState {
  return { id: String(id), prompt: text, parts: [{ type: "text", text }] };
}

/** The text of a newly composed message, joining its text parts. */
export function appendText(message: AppendMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** A send not yet acknowledged by the server: no submission id, so no real queue item to match. */
export type PendingSend = {
  readonly localId: string;
  readonly text: string;
  readonly lane: "queue" | "steer";
};

/**
 * The composer's queue, straight from the room's real `Thread.queue` (every player's pending
 * sends), plus our own sends still in flight to the server. `move`/`edit`/`remove` are no-ops: the
 * server has no way yet to change or withdraw one item of an already-queued submission.
 */
export function buildQueueAdapter(
  queue: readonly QueuedMessage[],
  pending: readonly PendingSend[],
  dispatch: (message: AppendMessage, lane: "queue" | "steer") => void,
): ExternalThreadQueueAdapter {
  const items = (lane: "queue" | "steer") => [
    ...queue
      .filter((item) => (item.mode === "steer" ? "steer" : "queue") === lane)
      .map((item) => queueItem(item.id, item.text)),
    ...pending
      .filter((item) => item.lane === lane)
      .map((item) => queueItem(item.localId, item.text)),
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
