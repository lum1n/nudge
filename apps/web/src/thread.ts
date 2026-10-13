import type {
  EntryRecord,
  InboxItem,
  InboxState,
  LiveState,
  ToolSlot,
} from "@earendil-works/pi-durable";
import type { FireEntryData, MessageEntryData } from "@nudge/server";
import type { ConversationView } from "./mirror.ts";

// Entry kinds of @nudge/core. The recorded fixture's tests fail when they drift.
const MESSAGE_ENTRY = "nudge.message";
const FIRE_ENTRY = "nudge.fire";

export type Author = { readonly playerId: string; readonly displayName: string };

export type ToolCallPart = {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: "pending" | "running" | "done";
  /** The result's text, once there is one. */
  readonly result?: string;
  readonly isError?: boolean;
  /** What the tool printed so far, while it runs. */
  readonly output?: string;
};

export type AssistantPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | ToolCallPart;

export type ThreadMessage =
  | {
      readonly role: "user";
      readonly id: string;
      readonly text: string;
      /** Absent for input without a player, such as the in-process `nudge chat`. */
      readonly author?: Author;
      readonly mine: boolean;
      readonly sentAt?: number;
    }
  /** A scheduled nudge that fired; the assistant answers it like a message. */
  | { readonly role: "nudge"; readonly id: string; readonly text: string; readonly firedAt: number }
  /** One answer: every model response and tool round between two messages. */
  | {
      readonly role: "assistant";
      readonly id: string;
      readonly parts: readonly AssistantPart[];
      readonly status: "running" | "done" | "stopped" | "failed";
      readonly error?: string;
    }
  /** Where the transcript starts over: earlier messages were summarized, or cleared. */
  | { readonly role: "marker"; readonly id: string; readonly kind: "compacted" | "reset" };

/** A message waiting for the assistant to get to it. */
export type QueuedMessage = {
  readonly id: number;
  readonly mode: "steer" | "followUp";
  readonly text: string;
  readonly author?: Author;
  readonly mine: boolean;
  readonly nudge: boolean;
};

/** Something about the room worth a status line. */
export type RoomStatus =
  | {
      readonly kind: "retrying";
      readonly attempt: number;
      readonly at: number;
      readonly error: string;
    }
  | { readonly kind: "compacting" }
  | { readonly kind: "compaction-failed"; readonly error: string };

export type Thread = {
  readonly messages: readonly ThreadMessage[];
  /** The assistant is busy in this room, whoever started it. */
  readonly isRunning: boolean;
  readonly queue: readonly QueuedMessage[];
  readonly status?: RoomStatus;
};

type Message = NonNullable<EntryRecord["model"]>[number];
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
type Content = AssistantMessage["content"][number];

/**
 * Turns a room's view into the messages a chat shows, for player `me`. Messages whose sources did
 * not change since the last call come back as the same objects, so rows can skip re-rendering.
 */
export class ThreadReader {
  private previous = new Map<string, { sources: readonly unknown[]; message: ThreadMessage }>();

  /**
   * `earlier` is history loaded by `onLoadEarlier`: entries that precede `view.entries`, oldest
   * first, not already part of the view.
   */
  read(view: ConversationView, me: string, earlier: readonly EntryRecord[] = []): Thread {
    const live = view.docs["pi.live"] as LiveState | undefined;
    const inbox = view.docs["pi.inbox"] as InboxState | undefined;
    const isRunning = live?.run !== undefined;
    const entries = earlier.length === 0 ? view.entries : [...earlier, ...view.entries];
    const results = new Map<string, EntryRecord>();
    for (const entry of entries)
      if (entry.kind === "pi.tool-result") {
        const id = toolResult(entry)?.toolCallId;
        if (id !== undefined) results.set(id, entry);
      }

    const next = new Map<string, { sources: readonly unknown[]; message: ThreadMessage }>();
    const messages: ThreadMessage[] = [];
    const keep = (id: string, sources: readonly unknown[], build: () => ThreadMessage) => {
      const before = this.previous.get(id);
      const message =
        before !== undefined && sameItems(before.sources, sources) ? before.message : build();
      next.set(id, { sources, message });
      messages.push(message);
    };

    // An answer collects assistant entries until the next message. It is named after the message
    // before it, so the in-flight answer keeps its id once its entry is written.
    let answer: EntryRecord[] = [];
    let after = "start";
    const endAnswer = (live?: LiveState) => {
      const generated = live?.generation?.message as AssistantMessage | undefined;
      if (answer.length === 0 && generated === undefined && !(live?.tools?.length ?? 0)) return;
      const entries = answer;
      const callResults = entries.flatMap((entry) =>
        toolCalls(entry).map((call) => results.get(call.id)),
      );
      const sources = [...entries, ...callResults, generated, live?.tools, live !== undefined];
      keep(`answer:${after}`, sources, () =>
        buildAnswer(`answer:${after}`, entries, results, live, generated),
      );
      answer = [];
    };

    for (const entry of entries) {
      switch (entry.kind) {
        case "pi.assistant":
          answer.push(entry);
          continue;
        case MESSAGE_ENTRY:
        case "pi.user":
        case FIRE_ENTRY:
        case "pi.compaction":
        case "pi.reset": {
          endAnswer();
          const id = `entry:${entry.id}`;
          keep(id, [entry, me], () => entryMessage(id, entry, me));
          after = id;
          continue;
        }
        default:
          // System prompts, tool results (shown with their calls) and extension bookkeeping.
          continue;
      }
    }
    endAnswer(isRunning ? live : undefined);
    this.previous = next;

    return {
      messages,
      isRunning,
      queue: (inbox?.items ?? []).flatMap((item) => queued(item, me)),
      ...withStatus(live),
    };
  }
}

function entryMessage(id: string, entry: EntryRecord, me: string): ThreadMessage {
  switch (entry.kind) {
    case MESSAGE_ENTRY: {
      const data = entry.data as MessageEntryData;
      return {
        role: "user",
        id,
        text: data.text,
        author: { playerId: data.playerId, displayName: data.displayName },
        mine: data.playerId === me,
        sentAt: data.sentAt,
      };
    }
    case FIRE_ENTRY: {
      const data = entry.data as FireEntryData;
      return { role: "nudge", id, text: data.message, firedAt: data.fireAt };
    }
    case "pi.compaction":
    case "pi.reset":
      return { role: "marker", id, kind: entry.kind === "pi.reset" ? "reset" : "compacted" };
    default: {
      const message = entry.model?.find((m) => m.role === "user");
      return {
        role: "user",
        id,
        text: message === undefined ? "" : text(message.content),
        mine: false,
      };
    }
  }
}

function buildAnswer(
  id: string,
  entries: readonly EntryRecord[],
  results: ReadonlyMap<string, EntryRecord>,
  live: LiveState | undefined,
  generated: AssistantMessage | undefined,
): ThreadMessage {
  const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
  const parts: AssistantPart[] = [];
  let last: AssistantMessage | undefined;
  for (const entry of entries)
    for (const message of entry.model ?? [])
      if (message.role === "assistant") {
        last = message;
        for (const content of message.content) {
          const part = toPart(content, results, slots);
          if (part !== undefined) parts.push(part);
        }
      }
  if (generated !== undefined)
    for (const content of generated.content) {
      const part = toPart(content, results, slots);
      if (part !== undefined) parts.push(part);
    }
  if (live !== undefined) return { role: "assistant", id, parts, status: "running" };
  if (last?.stopReason === "aborted") return { role: "assistant", id, parts, status: "stopped" };
  if (last?.stopReason === "error")
    return {
      role: "assistant",
      id,
      parts,
      status: "failed",
      ...(last.errorMessage === undefined ? {} : { error: last.errorMessage }),
    };
  return { role: "assistant", id, parts, status: "done" };
}

function toPart(
  content: Content,
  results: ReadonlyMap<string, EntryRecord>,
  slots: ReadonlyMap<string, ToolSlot>,
): AssistantPart | undefined {
  switch (content.type) {
    case "text":
      return content.text === "" ? undefined : { type: "text", text: content.text };
    case "thinking":
      return content.thinking === "" ? undefined : { type: "reasoning", text: content.thinking };
    case "toolCall": {
      const entry = results.get(content.id);
      const result = entry === undefined ? undefined : toolResult(entry);
      const slot = slots.get(content.id);
      return {
        type: "tool-call",
        toolCallId: content.id,
        toolName: content.name,
        args: content.arguments,
        status: result !== undefined ? "done" : (slot?.status ?? "pending"),
        ...(result === undefined ? {} : { result: text(result.content), isError: result.isError }),
        ...(slot?.output === undefined || result !== undefined ? {} : { output: slot.output }),
      };
    }
    default:
      return undefined;
  }
}

function queued(item: InboxItem, me: string): QueuedMessage[] {
  if (item.mode === "write") return [];
  const entry = item.entry as { kind?: string; data?: unknown } | undefined;
  if (entry?.kind === MESSAGE_ENTRY) {
    const data = entry.data as MessageEntryData;
    return [
      {
        id: item.id,
        mode: item.mode,
        text: data.text,
        author: { playerId: data.playerId, displayName: data.displayName },
        mine: data.playerId === me,
        nudge: false,
      },
    ];
  }
  if (entry?.kind === FIRE_ENTRY) {
    const data = entry.data as FireEntryData;
    return [{ id: item.id, mode: item.mode, text: data.message, mine: false, nudge: true }];
  }
  return [
    {
      id: item.id,
      mode: item.mode,
      text: text(item.content as Extract<Message, { role: "user" }>["content"]),
      mine: false,
      nudge: false,
    },
  ];
}

function withStatus(live: LiveState | undefined): { status?: RoomStatus } {
  const retry = live?.generation?.retry;
  if (retry !== undefined)
    return {
      status: {
        kind: "retrying",
        attempt: live!.generation!.attempt,
        at: retry.at,
        error: retry.error,
      },
    };
  if (live?.compactions?.some((compaction) => compaction.blocking))
    return { status: { kind: "compacting" } };
  if (live?.compactionFailure !== undefined)
    return { status: { kind: "compaction-failed", error: live.compactionFailure.error } };
  return {};
}

function toolCalls(entry: EntryRecord): { id: string }[] {
  return (entry.model ?? []).flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((content) => (content.type === "toolCall" ? [content] : []))
      : [],
  );
}

function toolResult(entry: EntryRecord): ToolResultMessage | undefined {
  return entry.model?.find(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
}

/** The text parts of a message's content, joined. */
function text(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
