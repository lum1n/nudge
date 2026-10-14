import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  CommitPublication,
  EntryRecord,
  Harness,
  JsonObject,
} from "@earendil-works/pi-durable";
import type { Approval, ApprovalsState } from "./approvals/approvals.ts";
import { APPROVAL_ENTRY } from "./approvals/approvals.ts";
import type { DirectoryState, Room } from "./identity/directory.ts";
import { MESSAGE_ENTRY } from "./host-api.ts";
import { FIRE_ENTRY } from "./nudges/timer-task.ts";

/** What prompted an answer: a person's message, a fired nudge or the outcome of an approval. */
export type AnswerCause = "message" | "nudge" | "approval";

/** Something a room's people may want to hear about even when they are not watching the room. */
export type RoomEvent =
  | {
      /** The assistant finished an answer. */
      readonly type: "answer";
      readonly roomId: string;
      /** The answer's text, all of its parts joined; personal values as the room sees them. */
      readonly text: string;
      readonly cause: AnswerCause;
      /** Id of the answer's last entry. */
      readonly entryId: number;
      readonly status: "done" | "stopped" | "failed";
    }
  | {
      /** An action waits for someone in the room to approve it. */
      readonly type: "approval";
      readonly roomId: string;
      readonly approval: Readonly<Approval>;
    };

export type RoomEventListener = (event: RoomEvent) => void;

const DIRECTORY = "nudge.directory";
const APPROVALS = "nudge.approvals";

/**
 * Turns the assistant's commits into `RoomEvent`s: answers once they end, and approvals once they
 * are asked for. Listeners run after the commit and can't hold it up; a throw is reported.
 * Events are not replayed: what happened while nobody listened, or while the host was down, is gone.
 */
export class RoomEvents {
  private readonly listeners = new Set<RoomEventListener>();
  private rooms = new Map<number, string>();
  /** Per conversation: the answer's text so far and what it answers. */
  private readonly answers = new Map<number, { parts: string[]; cause: AnswerCause }>();
  /** Per room: approval ids already pending, so each is announced once. */
  private readonly pending = new Map<string, Set<string>>();
  private readonly stop: () => void;

  constructor(
    harness: Harness,
    directory: DirectoryState | undefined,
    approvals: ReadonlyMap<string, ApprovalsState>,
    private readonly report: (error: unknown) => void,
  ) {
    this.index(directory);
    for (const [roomId, state] of approvals) this.pending.set(roomId, pendingIds(state));
    this.stop = harness.subscribeCommits((publication) => this.take(publication));
  }

  /** Returns a function that stops listening. */
  subscribe(listener: RoomEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.stop();
    this.listeners.clear();
  }

  private take(publication: CommitPublication): void {
    const events: RoomEvent[] = [];
    for (const change of publication.changes)
      if (change.type === "document" && change.record.kind === DIRECTORY && change.value !== null)
        this.index(change.value as unknown as DirectoryState);
    const entries = publication.changes
      .flatMap((change) => (change.type === "entry" ? [change.value] : []))
      .sort((a, b) => a.id - b.id);
    for (const entry of entries) {
      const event = this.entry(entry);
      if (event !== undefined) events.push(event);
    }
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== APPROVALS) continue;
      const roomId = change.record.key;
      if (roomId === undefined) continue;
      events.push(...this.approvals(roomId, change.value));
    }
    for (const event of events) this.emit(event);
  }

  private entry(entry: EntryRecord): RoomEvent | undefined {
    const roomId = this.rooms.get(entry.conversationId);
    if (roomId === undefined) return undefined;
    const cause = causeOf(entry.kind);
    if (cause !== undefined) {
      this.answers.set(entry.conversationId, { parts: [], cause });
      return undefined;
    }
    if (entry.kind !== "pi.assistant") return undefined;
    const message = entry.model?.find((m): m is AssistantMessage => m.role === "assistant");
    if (message === undefined) return undefined;
    const answer = this.answers.get(entry.conversationId) ?? { parts: [], cause: "message" };
    this.answers.set(entry.conversationId, answer);
    for (const part of message.content)
      if (part.type === "text" && part.text.trim() !== "") answer.parts.push(part.text.trim());
    if (message.stopReason === "toolUse" || message.stopReason === "pending") return undefined;
    this.answers.delete(entry.conversationId);
    const status =
      message.stopReason === "aborted"
        ? "stopped"
        : message.stopReason === "error"
          ? "failed"
          : "done";
    return {
      type: "answer",
      roomId,
      text: answer.parts.join("\n\n"),
      cause: answer.cause,
      entryId: entry.id,
      status,
    };
  }

  private approvals(roomId: string, value: JsonObject | null): RoomEvent[] {
    const state = value as unknown as ApprovalsState | null;
    const seen = this.pending.get(roomId) ?? new Set<string>();
    const now = state === null ? new Set<string>() : pendingIds(state);
    this.pending.set(roomId, now);
    return (state?.items ?? [])
      .filter((approval) => approval.status === "pending" && !seen.has(approval.id))
      .map((approval) => ({ type: "approval", roomId, approval: structuredClone(approval) }));
  }

  private emit(event: RoomEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private index(directory: DirectoryState | undefined): void {
    this.rooms = new Map(
      Object.values(directory?.rooms ?? {}).map((room: Room) => [room.conversationId, room.id]),
    );
  }
}

function causeOf(kind: string): AnswerCause | undefined {
  if (kind === FIRE_ENTRY) return "nudge";
  if (kind === APPROVAL_ENTRY) return "approval";
  if (kind === MESSAGE_ENTRY || kind === "pi.user") return "message";
  return undefined;
}

function pendingIds(state: ApprovalsState): Set<string> {
  return new Set(state.items.filter((item) => item.status === "pending").map((item) => item.id));
}
