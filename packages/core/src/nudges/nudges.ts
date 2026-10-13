import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness, TaskId } from "@earendil-works/pi-durable";
import type { Rooms } from "../identity/rooms.ts";
import { ScheduleDoc, type ScheduledNudge } from "./schedule.ts";
import { NudgeTimer } from "./timer-task.ts";

export type NudgeDraft = {
  readonly message: string;
  /** When it first fires, in ms on the assistant's clock. */
  readonly fireAt: number;
  /** Repeat interval in ms; absent for a one-off. */
  readonly every?: number;
};

/** Messages the assistant delivers to a room on its own, at a set time. */
export class Nudges {
  constructor(
    private readonly harness: Harness,
    private readonly rooms: Rooms,
    private readonly now: () => number,
  ) {}

  async schedule(roomId: string, draft: NudgeDraft, context: Context): Promise<ScheduledNudge> {
    const room = await this.rooms.get(roomId, context);
    if (room === undefined) throw new Error(`No room "${roomId}"`);
    const message = draft.message.trim();
    if (message === "") throw new Error("A nudge needs a message");
    if (!Number.isFinite(draft.fireAt)) throw new Error("A nudge needs a time");
    if (draft.every !== undefined && !(draft.every > 0))
      throw new Error("A nudge repeats after a positive interval");
    // The task and its schedule entry commit together, so neither exists alone.
    return this.harness.commit(async (tx) => {
      const id = await tx.createTask(
        NudgeTimer,
        {
          roomId,
          message,
          fireAt: draft.fireAt,
          ...(draft.every === undefined ? {} : { every: draft.every }),
        },
        {
          ownership: { kind: "conversation" },
          conversationId: room.conversationId as ConversationId,
          background: true,
        },
      );
      const nudge: ScheduledNudge = {
        id: String(id),
        roomId,
        conversationId: room.conversationId,
        message,
        fireAt: draft.fireAt,
        ...(draft.every === undefined ? {} : { every: draft.every }),
        createdAt: this.now(),
      };
      (await tx.doc(ScheduleDoc)).nudges[nudge.id] = { ...nudge };
      return nudge;
    }, context);
  }

  /** Pending nudges, soonest first; only those of `roomIds` when given. */
  async list(context: Context, roomIds?: readonly string[]): Promise<ScheduledNudge[]> {
    const schedule = await this.harness.snapshot(ScheduleDoc, context);
    return Object.values(schedule?.nudges ?? {})
      .filter((nudge) => roomIds === undefined || roomIds.includes(nudge.roomId))
      .map((nudge) => ({ ...nudge }))
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  async get(id: string, context: Context): Promise<ScheduledNudge | undefined> {
    const nudge = (await this.harness.snapshot(ScheduleDoc, context))?.nudges[id];
    return nudge === undefined ? undefined : { ...nudge };
  }

  /** Stops a pending nudge. False when there is none with that id. */
  async cancel(id: string, context: Context): Promise<boolean> {
    if ((await this.get(id, context)) === undefined) return false;
    const taskId = Number(id) as TaskId;
    if ((await this.harness.abortTask(taskId, context)) === "marked")
      await this.harness.waitForTask(taskId, context);
    // The abort handler drops the entry; this covers a task that ended some other way.
    await this.forget([id], context);
    return true;
  }

  /** Drops entries whose task is gone or over, say after a fault. Runs at open. */
  async reconcile(context: Context): Promise<void> {
    const stale: string[] = [];
    for (const nudge of await this.list(context)) {
      const task = await this.harness.getTask(Number(nudge.id) as TaskId, context);
      if (task === undefined || task.state.status === "terminal") stale.push(nudge.id);
    }
    await this.forget(stale, context);
  }

  private async forget(ids: readonly string[], context: Context): Promise<void> {
    if (ids.length === 0) return;
    await this.harness.commit(async (tx) => {
      const schedule = await tx.doc(ScheduleDoc);
      for (const id of ids) delete schedule.nudges[id];
    }, context);
  }
}
