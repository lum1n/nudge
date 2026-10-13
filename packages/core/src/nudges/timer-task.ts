import { defineTask } from "@earendil-works/pi-durable";
import { nextFire, ScheduleDoc } from "./schedule.ts";

export type NudgeInput = {
  roomId: string;
  message: string;
  /** When it first fires, in ms on the assistant's clock. */
  fireAt: number;
  /** Repeat interval in ms; absent for a one-off. */
  every?: number;
};

/** `count` is how many times the nudge has fired. */
export type NudgeCheckpoint =
  | { phase: "wait"; fireAt: number; count: number }
  | { phase: "fire"; fireAt: number; count: number };

export type NudgeResult = { fired: number };

export const FIRE_ENTRY = "nudge.fire";

/** Stored with the input a nudge places in its room. */
export type FireEntryData = {
  nudgeId: string;
  message: string;
  fireAt: number;
};

/**
 * One scheduled nudge: sleeps until `fireAt`, then submits the message to its room as input the
 * assistant answers. Owned by the room's conversation and `background`, so it never holds up the
 * room. The sleep is in memory: a host that is down fires late, at its next start.
 */
export const NudgeTimer = defineTask<NudgeInput, NudgeCheckpoint, NudgeResult>({
  name: "nudge.timer",
  version: 1,
  initial: (input) => ({ phase: "wait", fireAt: input.fireAt, count: 0 }),
  phases: {
    wait: async (task, runtime, context) => {
      const { fireAt, count } = task.state.checkpoint;
      await runtime.sleep(fireAt, context);
      await runtime.commit(
        () => ({ status: "running", checkpoint: { phase: "fire", fireAt, count } }),
        context,
      );
    },
    fire: async (task, runtime, context) => {
      const { fireAt, count } = task.state.checkpoint;
      const { message, every } = task.input;
      const nudgeId = String(runtime.taskId);
      const room = await runtime.conversation(runtime.conversationId, context);
      if (room === undefined) throw new Error(`Nudge ${nudgeId} has no room`);
      // The request id makes a rerun after a crash find this submission instead of adding another.
      await room.submit(
        {
          type: "input",
          content:
            `A nudge you scheduled is due now: ${message}\n` +
            `Say it to the room now, in your own words. Nothing needs scheduling.`,
          whenBusy: "followUp",
          requestId: `nudge:${nudgeId}:${count}`,
          entry: { kind: FIRE_ENTRY, data: { nudgeId, message, fireAt } satisfies FireEntryData },
        },
        context,
      );
      await runtime.commit(async (tx) => {
        const schedule = await tx.doc(ScheduleDoc);
        if (every === undefined) {
          delete schedule.nudges[nudgeId];
          return {
            status: "terminal",
            outcome: { status: "completed", result: { fired: count + 1 } },
          };
        }
        const next = nextFire(fireAt, every, runtime.now());
        const entry = schedule.nudges[nudgeId];
        if (entry !== undefined) entry.fireAt = next;
        return { status: "running", checkpoint: { phase: "wait", fireAt: next, count: count + 1 } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    const fired = task.state.checkpoint.count;
    await runtime.commit(async (tx) => {
      delete (await tx.doc(ScheduleDoc)).nudges[String(runtime.taskId)];
      return { status: "terminal", outcome: { status: "aborted", result: { fired } } };
    }, context);
  },
});
