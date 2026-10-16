import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { roomOf } from "../identity/directory.ts";
import { keepsPlaceholders } from "../privacy/tool-values.ts";
import { currentTurn } from "../privacy/turn.ts";
import type { Nudges } from "./nudges.ts";
import { formatTime, parseTime, type ScheduledNudge } from "./schedule.ts";

export type NudgeToolOptions = {
  /** Resolved at call time: the tools are registered before the assistant opens. */
  readonly nudges: () => Nudges;
  readonly timeZone: string;
  readonly now: () => number;
};

const MINUTE = 60_000;

/** `schedule_nudge`, `list_nudges` and `cancel_nudge`, each about the room the model talks in. */
export function createNudgeTools(options: NudgeToolOptions): ToolRegistration[] {
  const { timeZone } = options;
  const describe = (nudge: ScheduledNudge) =>
    `${nudge.id}: ${formatTime(nudge.fireAt, timeZone)}` +
    (nudge.every === undefined ? "" : `, then every ${minutes(nudge.every)}`) +
    (nudge.privateTo === undefined ? "" : ` (private to ${nudge.privateTo.displayName})`) +
    ` — ${nudge.message}`;
  // A private nudge exists only in its owner's private turns.
  const visible = (nudge: ScheduledNudge) =>
    nudge.privateTo === undefined || nudge.privateTo.playerId === currentTurn().privateTo?.playerId;
  const text = (value: string, isError = false) => ({
    output: [{ type: "text" as const, text: value }],
    ...(isError ? { isError } : {}),
  });

  const schedule = defineTool({
    name: "schedule_nudge",
    description:
      "Schedule a message you will deliver to this conversation later on your own, such as a " +
      "reminder. Give either `at` or `in_minutes`. Add `every_minutes` to repeat it.",
    parameters: Type.Object({
      message: Type.String({ description: "What to say or remind about when it fires." }),
      at: Type.Optional(
        Type.String({
          description: `Local time in ${timeZone}, like 2026-10-13T14:30.`,
        }),
      ),
      in_minutes: Type.Optional(Type.Number({ description: "Minutes from now." })),
      every_minutes: Type.Optional(
        Type.Number({ description: "Repeat this often, in minutes; at least 1." }),
      ),
    }),
    execute: async (args, api, context) => {
      if ((args.at === undefined) === (args.in_minutes === undefined))
        return text("Give exactly one of `at` and `in_minutes`.", true);
      const now = options.now();
      const fireAt =
        args.at === undefined ? now + args.in_minutes! * MINUTE : parseTime(args.at, timeZone);
      if (fireAt === undefined)
        return text(`Could not read the time "${args.at}"; use 2026-10-13T14:30.`, true);
      if (fireAt < now - MINUTE) return text("That time has passed.", true);
      if (args.every_minutes !== undefined && !(args.every_minutes >= 1))
        return text("`every_minutes` is at least 1.", true);
      const room = await roomOf(api, api.conversationId, context);
      const nudge = await options.nudges().schedule(
        room.id,
        {
          message: args.message,
          fireAt,
          ...(args.every_minutes === undefined ? {} : { every: args.every_minutes * MINUTE }),
        },
        context,
      );
      return text(`Scheduled nudge ${describe(nudge)}`);
    },
  });

  const list = defineTool({
    name: "list_nudges",
    description: "List the nudges scheduled in this conversation, soonest first.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const room = await roomOf(api, api.conversationId, context);
      const nudges = (await options.nudges().list(context, [room.id])).filter(visible);
      return text(nudges.length === 0 ? "No nudges scheduled." : nudges.map(describe).join("\n"));
    },
  });

  const cancel = defineTool({
    name: "cancel_nudge",
    description: "Cancel a scheduled nudge of this conversation by its id.",
    parameters: Type.Object({ id: Type.String({ description: "From list_nudges." }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const room = await roomOf(api, api.conversationId, context);
      const nudges = options.nudges();
      const nudge = await nudges.get(args.id, context);
      // Another room's nudges do not exist from here.
      if (nudge === undefined || nudge.roomId !== room.id || !visible(nudge))
        return text(`No nudge ${args.id} in this conversation.`, true);
      await nudges.cancel(args.id, context);
      return text(`Cancelled nudge ${describe(nudge)}`);
    },
  });

  return [keepsPlaceholders(schedule), list, cancel] as ToolRegistration[];
}

function minutes(ms: number): string {
  const n = Math.round(ms / MINUTE);
  if (n % 1440 === 0) return n === 1440 ? "day" : `${n / 1440} days`;
  if (n % 60 === 0) return n === 60 ? "hour" : `${n / 60} hours`;
  return n === 1 ? "minute" : `${n} minutes`;
}
