import type { Context } from "@earendil-works/chord";
import type { Models, Usage } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord/delta";
import {
  type ConversationId,
  type DocumentReader,
  defineDocFamily,
  type Harness,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type { Change } from "../changes.ts";
import type { Room } from "../identity/directory.ts";
import type { Rooms } from "../identity/rooms.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "done" | "failed";

// Stored in a document, so plain JSON.
export type Approval = {
  /** `a1`, `a2`, … within its room. */
  id: string;
  /** The extension that asked, and whose handler runs the action. */
  extension: string;
  /** Which of the extension's handlers runs it. */
  kind: string;
  /** What people are asked to approve, in a sentence or two. */
  summary: string;
  /** What the handler gets; the extension's own. */
  payload: JsonValue;
  requestedAt: number;
  status: ApprovalStatus;
  decidedBy?: { playerId: string; displayName: string };
  decidedAt?: number;
  /** What the handler reported, once it ran. */
  result?: string;
};

export type ApprovalsState = {
  /** Oldest first: pending ones and the most recent decided ones. */
  items: Approval[];
  next: number;
};

/** Actions waiting for a person in the room to approve them, keyed by room id. */
export const ApprovalsDoc = defineDocFamily<ApprovalsState, null>({
  kind: "nudge.approvals",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ items: [], next: 1 }),
});

export const APPROVAL_ENTRY = "nudge.approval";

/** Stored with the input that tells the room how an approval ended. */
export type ApprovalEntryData = {
  readonly id: string;
  readonly summary: string;
  readonly status: ApprovalStatus;
  readonly decidedBy?: string;
};

export type ApprovalDraft = {
  readonly extension: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: JsonValue;
};

/** What an approved action's handler gets. */
export type ApprovalRun = {
  readonly room: Room;
  readonly approval: Readonly<Approval>;
  /** Commits to the assistant's documents, like a tool's `api.commit`. */
  commit<T>(apply: (tx: Tx) => Promise<T> | T): Promise<T>;
  /** The assistant's models, redacting like a tool's `api.models`, for actions that ask one. */
  readonly models: Models;
  readonly context: Context;
};

export type ApprovalOutcome = {
  readonly text: string;
  readonly isError?: boolean;
  /** What model requests the action made cost; it counts for the room, like a tool's. */
  readonly usage?: Usage;
};

/** Runs one kind of approved action. A throw counts as a failure with its message. */
export type ApprovalHandler = (payload: JsonValue, run: ApprovalRun) => Promise<ApprovalOutcome>;

export const MAX_PENDING = 20;
/** Decided approvals kept per room for history. */
const KEEP_DECIDED = 30;

/**
 * Asks the people in a room to approve an action, inside a commit. A tool calls this and returns
 * at once; the action runs when someone approves, and the room hears the outcome as new input.
 */
export async function requestApproval(
  tx: Tx,
  roomId: string,
  draft: ApprovalDraft,
  now: number,
): Promise<Approval> {
  const summary = draft.summary.trim();
  if (summary === "") throw new Error("An approval needs a summary");
  const state = await tx.doc(ApprovalsDoc, roomId, null);
  if (state.items.filter((item) => item.status === "pending").length >= MAX_PENDING)
    throw new Error(`This conversation has ${MAX_PENDING} approvals waiting already`);
  const approval: Approval = {
    id: `a${state.next}`,
    extension: draft.extension,
    kind: draft.kind,
    summary,
    payload: draft.payload,
    requestedAt: now,
    status: "pending",
  };
  state.next += 1;
  state.items.push(structuredClone(approval));
  return approval;
}

export class ApprovalNotFound extends Error {
  override name = "ApprovalNotFound";
}

export class AlreadyDecided extends Error {
  override name = "AlreadyDecided";
}

export type Decision = {
  readonly approve: boolean;
  readonly by: { readonly playerId: string; readonly displayName: string };
};

/** Each room's approvals, for hosts: list them and decide. */
export class Approvals {
  constructor(
    private readonly harness: Harness,
    private readonly rooms: Rooms,
    private readonly now: () => number,
    private readonly models: Models,
    /** The handler an installed extension has for `kind`, looked up when an approval runs. */
    private readonly handler: (extension: string, kind: string) => ApprovalHandler | undefined,
    private readonly changed: (change: Change) => void = () => {},
  ) {}

  /** Newest first. */
  async list(roomId: string, context: Context): Promise<Approval[]> {
    return (await readItems(this.harness, roomId, context)).reverse();
  }

  async get(roomId: string, id: string, context: Context): Promise<Approval | undefined> {
    return (await readItems(this.harness, roomId, context)).find((item) => item.id === id);
  }

  /**
   * Approves or denies a pending approval. An approved action runs at once; either way the room
   * gets the outcome as input, so the model can tell people. Checking that `by` may use the room
   * is the host's job.
   */
  async decide(
    roomId: string,
    id: string,
    decision: Decision,
    context: Context,
  ): Promise<Approval> {
    const room = await this.rooms.get(roomId, context);
    if (room === undefined) throw new Error(`No room "${roomId}"`);
    const by = { playerId: decision.by.playerId, displayName: decision.by.displayName };
    const decided = await this.update(roomId, id, context, (item) => {
      if (item.status !== "pending") throw new AlreadyDecided(`Approval ${id} is ${item.status}`);
      item.status = decision.approve ? "approved" : "denied";
      item.decidedBy = by;
      item.decidedAt = this.now();
    });
    if (!decision.approve) {
      await this.tell(room, decided, context);
      return decided;
    }
    // Marked approved before it runs: after a crash it is never run a second time.
    const outcome = await this.run(room, decided, context);
    const finished = await this.update(
      roomId,
      id,
      context,
      (item) => {
        item.status = outcome.isError ? "failed" : "done";
        item.result = outcome.text;
      },
      async (tx) => {
        if (outcome.usage === undefined) return;
        const usage = await tx.doc(UsageDoc, room.conversationId as ConversationId);
        const key = `${decided.extension}/${decided.kind}`;
        usage.tools[key] = sumUsage(usage.tools[key], outcome.usage);
      },
    );
    await this.tell(room, finished, context);
    return finished;
  }

  /**
   * Approved actions that never finished, say because the host stopped mid-way, may or may not
   * have happened; they are marked failed rather than run again. Runs at open.
   */
  async recover(context: Context): Promise<void> {
    for (const room of await this.rooms.list(context)) {
      const stuck = (await readItems(this.harness, room.id, context)).filter(
        (item) => item.status === "approved",
      );
      for (const item of stuck) {
        const failed = await this.update(room.id, item.id, context, (stored) => {
          stored.status = "failed";
          stored.result = "Stopped while running; it may or may not have happened. Check first.";
        });
        await this.tell(room, failed, context);
      }
    }
  }

  private async run(room: Room, approval: Approval, context: Context): Promise<ApprovalOutcome> {
    const handler = this.handler(approval.extension, approval.kind);
    if (handler === undefined)
      return {
        text: `The extension "${approval.extension}" can't run "${approval.kind}"; is it still installed?`,
        isError: true,
      };
    try {
      return await handler(approval.payload, {
        room,
        approval,
        commit: (apply) => this.harness.commit(apply, context),
        models: this.models,
        context,
      });
    } catch (error) {
      return { text: (error as Error).message, isError: true };
    }
  }

  private async update(
    roomId: string,
    id: string,
    context: Context,
    change: (item: Approval) => void,
    /** More to change in the same commit. */
    also?: (tx: Tx) => Promise<void>,
  ): Promise<Approval> {
    const updated = await this.harness.commit(async (tx) => {
      await also?.(tx);
      const state = await tx.doc(ApprovalsDoc, roomId, null);
      const item = state.items.find((stored) => stored.id === id);
      if (item === undefined) throw new ApprovalNotFound(`No approval ${id} in room "${roomId}"`);
      change(item);
      const decided = state.items.filter((stored) => stored.status !== "pending");
      for (const old of decided.slice(0, Math.max(0, decided.length - KEEP_DECIDED)))
        state.items.splice(state.items.indexOf(old), 1);
      return copy(item);
    }, context);
    this.changed({ kind: "approvals", roomId });
    return updated;
  }

  /** Tells the room how an approval ended, as input the assistant answers. */
  private async tell(room: Room, approval: Approval, context: Context): Promise<void> {
    const conversation = await this.harness.conversation(
      room.conversationId as ConversationId,
      context,
    );
    if (conversation === undefined) return;
    const who = approval.decidedBy?.displayName ?? "nobody";
    const content =
      approval.status === "denied"
        ? `${who} denied approval ${approval.id} (${approval.summary}). Don't do it.`
        : approval.status === "done"
          ? `${who} approved ${approval.id} (${approval.summary}) and it was done:\n${approval.result ?? ""}`
          : `${who} approved ${approval.id} (${approval.summary}) but it failed:\n${approval.result ?? ""}`;
    await conversation.submit(
      {
        type: "input",
        content: `${content}\nTell the room briefly.`,
        whenBusy: "followUp",
        requestId: `approval:${approval.id}:${approval.status}`,
        entry: {
          kind: APPROVAL_ENTRY,
          data: {
            id: approval.id,
            summary: approval.summary,
            status: approval.status,
            ...(approval.decidedBy ? { decidedBy: approval.decidedBy.displayName } : {}),
          } satisfies ApprovalEntryData,
        },
      },
      context,
    );
  }
}

async function readItems(read: DocumentReader, roomId: string, context: Context) {
  const state = await read.snapshot(ApprovalsDoc, roomId, context);
  return (state?.items ?? []).map(copy);
}

function sumUsage(total: Readonly<Usage> | undefined, add: Usage): Usage {
  const cost = (key: keyof Usage["cost"]) => (total?.cost[key] ?? 0) + add.cost[key];
  return {
    input: (total?.input ?? 0) + add.input,
    output: (total?.output ?? 0) + add.output,
    cacheRead: (total?.cacheRead ?? 0) + add.cacheRead,
    cacheWrite: (total?.cacheWrite ?? 0) + add.cacheWrite,
    totalTokens: (total?.totalTokens ?? 0) + add.totalTokens,
    cost: {
      input: cost("input"),
      output: cost("output"),
      cacheRead: cost("cacheRead"),
      cacheWrite: cost("cacheWrite"),
      total: cost("total"),
    },
  };
}

/** A plain copy of a stored approval; documents hand out proxies. */
function copy(item: Readonly<Approval>): Approval {
  return JSON.parse(JSON.stringify(item)) as Approval;
}
