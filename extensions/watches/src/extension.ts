import {
  type Context,
  type Conversation,
  type ConversationId,
  currentTurn,
  defineNudgeExtension,
  defineTask,
  defineTool,
  DirectoryDoc,
  type DocumentReader,
  type ExtensionHost,
  FIRE_ENTRY,
  type FireEntryData,
  keepsPlaceholders,
  roomOf,
  section,
  type TaskId,
  type TaskRuntime,
  Type,
  untrustedData,
} from "@nudge/core";
import { ScriptRun, type ScriptRunResult, ScriptsDoc } from "@nudge/ext-scripts";
import { type Found, parseReport, remember, type Report, type Watch, WatchesDoc } from "./model.ts";

const VERSION = "0.1.0";

/** Who a watch added now is private to, if the turn is private. */
function privately(): { privateTo?: { playerId: string; displayName: string } } {
  const { privateTo } = currentTurn();
  return privateTo === undefined ? {} : { privateTo: { ...privateTo } };
}

/** A private watch exists only in its owner's private turns. */
function visible(watch: Watch): boolean {
  return visibleTo(watch.privateTo);
}

function visibleTo(privateTo: { playerId: string } | undefined): boolean {
  return privateTo === undefined || privateTo.playerId === currentTurn().privateTo?.playerId;
}
const MINUTE = 60_000;

const Settings = Type.Object({
  /** The shortest time between checks; each check is a model run with tools, so it costs. */
  minMinutes: Type.Number({
    default: 30,
    minimum: 0,
    description: "Fewest minutes between two checks of a watch; each check is a paid model run.",
  }),
  minScriptMinutes: Type.Number({
    default: 5,
    minimum: 0,
    description:
      "Fewest minutes between two checks of a watch that runs a saved script; those cost no model run.",
  }),
  maxPerRoom: Type.Number({
    default: 10,
    minimum: 1,
    description: "Most watches one room may have at a time.",
  }),
});

type TimerInput = { roomId: string; watchId: string; every: number; firstAt: number };
type TimerCheckpoint = {
  phase: "wait" | "check";
  at: number;
  count: number;
  /** The check's script run, once started. */
  run?: number;
};

/**
 * What the model is asked in a check; its reply is read, not shown. Each check starts afresh, so
 * it is given the keys earlier checks used, to name the same item the same way. They aren't
 * marked as untrusted data, which would make every check ask before it calls out (ADR 20); short
 * one-line keys, quoted, leave little room to say anything.
 */
export function checkPrompt(watch: Pick<Watch, "what" | "seen">): string {
  const keys = watch.seen
    .slice(-50)
    .filter((key) => key.length <= 200 && !/[\r\n]/.test(key))
    .map((key) => JSON.stringify(key));
  return [
    "This is a scheduled check for a watch, not a conversation: nobody reads this reply.",
    `The watch: ${watch.what}`,
    "Use your tools (connectors, browsing) to check it now. Don't schedule nudges, ask for " +
      "approvals, change anything or add watches.",
    'End your reply with only a JSON object: {"items":[{"key":"…","text":"…"}]}, listing ' +
      "everything that matches right now. `key` names an item the same way in every check (its " +
      'URL or id; a release by its version alone, like "2.1.310"); `text` is one short line ' +
      "about it. When the watch is a condition, such as a price above a limit, give one item " +
      'while it holds, keyed by what it is about (like "price-above-2kr-2026-10-15"). Give ' +
      '{"items":[]} when nothing matches.',
    ...(keys.length === 0
      ? []
      : [
          `Keys earlier checks gave, newest last; give the same key for the same item: ${keys.join(", ")}`,
        ]),
  ].join("\n");
}

/**
 * The input a room gets when a check found something new; it answers as to a fired nudge. What
 * was found came from outside, so it is marked as untrusted data (ADR 20).
 */
export function foundPrompt(watch: Pick<Watch, "id" | "what">, found: readonly Found[]): string {
  return [
    `Your watch ${watch.id} ("${watch.what}") found something new:`,
    untrustedData(
      "watch",
      [
        ...found.slice(0, 20).map((item) => `- ${item.text} (${item.key})`),
        ...(found.length > 20 ? [`…and ${found.length - 20} more.`] : []),
      ].join("\n"),
    ),
    "Tell the room about it now, in your own words, without the untrusted-data markers. Nothing needs scheduling.",
  ].join("\n");
}

export const watchesExtension = defineNudgeExtension({
  name: "watches",
  version: VERSION,
  apiVersion: "1.0",
  description:
    "Watches: the assistant checks something on a schedule and tells the room only when something new turns up.",
  settings: Settings,
  setup: (host) => {
    const { minMinutes, minScriptMinutes, maxPerRoom } = host.settings;
    const timer = createTimer(host);

    const text = (value: string, isError = false) => ({
      output: [{ type: "text" as const, text: value }],
      ...(isError ? { isError } : {}),
    });
    const describe = (watch: Watch) =>
      `${watch.id}: every ${duration(watch.every)} — ${watch.what}` +
      (watch.script === undefined ? "" : ` (runs script ${watch.script})`) +
      (watch.lastCheckAt === undefined
        ? " (not checked yet)"
        : ` (${watch.checks} checks, ${watch.seen.length} seen` +
          (watch.lastError === undefined ? "" : `, last check failed: ${watch.lastError}`) +
          ")");

    const add = defineTool({
      name: "add_watch",
      description:
        "Watch something for this conversation: check it on a schedule with your tools and tell " +
        "the room only when something new matches, such as new listings for a search, a price " +
        "under a limit, or a page that changes. The first check runs at once. Each check is a " +
        "model run with your tools, unless `script` names a saved script (save_script) that " +
        "returns the items: then checks cost nothing and you hear only of news.",
      parameters: Type.Object({
        what: Type.String({
          description:
            "What to check and what counts as a match, with every detail a later check needs " +
            "(site, search, limits).",
        }),
        every_minutes: Type.Number({
          description: `How often to check; at least ${minMinutes}, or ${minScriptMinutes} with a script.`,
        }),
        script: Type.Optional(
          Type.String({ description: "A saved script each check runs instead of you." }),
        ),
      }),
      execute: async (args, api, context) => {
        if (await isSide(api, api.conversationId, context))
          return text("Watches can't be added from a watch's own check.", true);
        const least = args.script === undefined ? minMinutes : minScriptMinutes;
        if (!(args.every_minutes >= least) || args.every_minutes <= 0)
          return text(`Check at most every ${least} minutes.`, true);
        const what = args.what.trim();
        if (what === "") return text("Say what to watch.", true);
        const room = await roomOf(api, api.conversationId, context);
        if (args.script !== undefined) {
          const script = (await api.snapshot(ScriptsDoc, room.id, context))?.items.find(
            (item) => item.name === args.script,
          );
          if (script === undefined || !visibleTo(script.privateTo))
            return text(
              `No saved script ${args.script} here; save it with save_script first.`,
              true,
            );
        }
        const every = Math.round(args.every_minutes * MINUTE);
        const now = host.now();
        const watch = await api.commit(async (tx) => {
          const state = await tx.doc(WatchesDoc, room.id, null);
          if (state.items.length >= maxPerRoom)
            throw new Error(`This conversation has ${maxPerRoom} watches already`);
          const id = `w${state.next}`;
          const taskId = await tx.createTask(
            timer,
            { roomId: room.id, watchId: id, every, firstAt: now },
            {
              ownership: { kind: "conversation" },
              conversationId: room.conversationId as ConversationId,
              background: true,
            },
          );
          const watch: Watch = {
            id,
            roomId: room.id,
            what,
            every,
            taskId: String(taskId),
            seen: [],
            checks: 0,
            createdAt: now,
            ...privately(),
            ...(args.script === undefined ? {} : { script: args.script }),
          };
          state.next += 1;
          state.items.push(structuredClone(watch));
          return watch;
        }, context);
        return text(`Added watch ${describe(watch)}. The first check runs now.`);
      },
    });

    const list = defineTool({
      name: "list_watches",
      description: "List this conversation's watches.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const items = ((await api.snapshot(WatchesDoc, room.id, context))?.items ?? []).filter(
          visible,
        );
        return text(items.length === 0 ? "No watches." : items.map(describe).join("\n"));
      },
    });

    const remove = defineTool({
      name: "remove_watch",
      description: "Stop and remove one of this conversation's watches by its id.",
      parameters: Type.Object({ id: Type.String({ description: "From list_watches." }) }),
      replay: "safe",
      execute: async (args, api, context) => {
        if (await isSide(api, api.conversationId, context))
          return text("Watches can't be removed from a watch's own check.", true);
        const room = await roomOf(api, api.conversationId, context);
        const watch = (await api.snapshot(WatchesDoc, room.id, context))?.items.find(
          (item) => item.id === args.id,
        );
        if (watch === undefined || !visible(watch))
          return text(`No watch ${args.id} in this conversation.`, true);
        await stopWatch(host, watch, context);
        return text(`Removed watch ${describe(watch)}`);
      },
    });

    return {
      tasks: [timer],
      // What to watch is kept as the model wrote it, with placeholders.
      tools: [keepsPlaceholders(add), list, remove],
      sections: [
        section("watches", async (input, context) => {
          const room = await roomOf(input.read, input.conversationId, context).catch(
            () => undefined,
          );
          if (room === undefined) return undefined;
          const items = (await input.read.snapshot(WatchesDoc, room.id, context))?.items ?? [];
          if (items.length === 0) return undefined;
          return (
            "Watches of this conversation (list_watches has their state):\n" +
            items
              .map((watch) => `- ${watch.id}: every ${duration(watch.every)} — ${watch.what}`)
              .join("\n")
          );
        }),
      ],
    };
  },
});

/** Stops a watch's timer and forgets it and its side conversation. */
async function stopWatch(
  host: Pick<ExtensionHost<unknown>, "assistant">,
  watch: Watch,
  context: Context,
): Promise<void> {
  const nudge = host.assistant();
  const taskId = Number(watch.taskId) as TaskId;
  if ((await nudge.harness.abortTask(taskId, context)) === "marked")
    await nudge.harness.waitForTask(taskId, context);
  await nudge.harness.commit(async (tx) => {
    const state = await tx.doc(WatchesDoc, watch.roomId, null);
    state.items = state.items.filter((item) => item.id !== watch.id);
  }, context);
  if (watch.sideId !== undefined) await nudge.rooms.dropSide(watch.sideId, context);
}

/** Whether a conversation is a side conversation, such as a watch's own check. */
async function isSide(
  read: DocumentReader,
  conversationId: number,
  context: Context,
): Promise<boolean> {
  const directory = await read.snapshot(DirectoryDoc, context);
  return directory?.sides?.[String(conversationId)] !== undefined;
}

/**
 * One watch's timer: sleeps until the next check, runs it (its script, or a model run in the
 * watch's side conversation), and tells the room what is new. Owned by the room's conversation and `background`, like a nudge.
 */
function createTimer(host: Pick<ExtensionHost<unknown>, "assistant" | "now">) {
  return defineTask<TimerInput, TimerCheckpoint, { checks: number }>({
    name: "watches.timer",
    version: 1,
    initial: (input) => ({ phase: "wait", at: input.firstAt, count: 0 }),
    phases: {
      wait: async (task, runtime, context) => {
        const { at, count } = task.state.checkpoint;
        await runtime.sleep(at, context);
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "check", at, count } }),
          context,
        );
      },
      check: async (task, runtime, context) => {
        const { at, count } = task.state.checkpoint;
        const { roomId, watchId, every } = task.input;
        const nudge = host.assistant();
        const read = async () =>
          (await runtime.snapshot(WatchesDoc, roomId, context))?.items.find(
            (item) => item.id === watchId,
          );
        const watch = await read();
        if (watch === undefined)
          return runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: { checks: count } },
            }),
            context,
          );

        let report: Report | undefined;
        let error: string | undefined;
        try {
          report =
            watch.script === undefined
              ? await checkWithModel(watch, count, nudge, runtime, context)
              : await checkWithScript(
                  watch,
                  watch.script,
                  task.state.checkpoint,
                  nudge,
                  runtime,
                  context,
                );
        } catch (caught) {
          if (runtime.signal.aborted) throw caught;
          error = (caught as Error).message;
        }

        const found = report?.items ?? [];
        const fresh = found.filter((item) => !watch.seen.includes(item.key));
        if (fresh.length > 0) {
          const room = await nudge.rooms.get(roomId, context);
          const conversation =
            room === undefined
              ? undefined
              : await runtime.conversation(room.conversationId as ConversationId, context);
          const fire = {
            nudgeId: `watch-${watchId}`,
            message: `Watch ${watchId}: ${fresh.length} new — ${watch.what}`,
            fireAt: host.now(),
            source: "watch",
            ...(watch.privateTo === undefined ? {} : { privateTo: watch.privateTo }),
          } satisfies FireEntryData;
          // The request id makes a rerun after a crash find this submission instead of adding another.
          const requestId = `watch:${watchId}:${count}:found`;
          if (report?.message !== undefined && room !== undefined) {
            // The script said it all: posted as it is, and no model answers it. A write goes
            // through the room's own handle, which queues it behind a run in progress.
            const own = await nudge.harness.conversation(
              room.conversationId as ConversationId,
              context,
            );
            await own?.submit(
              {
                type: "write",
                requestId,
                entry: {
                  kind: FIRE_ENTRY,
                  data: { ...fire, message: report.message, said: true },
                  model: [
                    {
                      role: "user",
                      content: `Your watch ${watchId} ("${watch.what}") posted this to the room:\n${untrustedData("watch", report.message)}`,
                      timestamp: host.now(),
                    },
                  ],
                },
              },
              context,
            );
          } else
            await conversation?.submit(
              {
                type: "input",
                content: foundPrompt(watch, fresh),
                whenBusy: "followUp",
                requestId,
                entry: { kind: FIRE_ENTRY, data: fire },
              },
              context,
            );
        }

        const next = nextCheck(at, every, host.now());
        await runtime.commit(async (tx) => {
          const item = (await tx.doc(WatchesDoc, roomId, null)).items.find((i) => i.id === watchId);
          if (item === undefined)
            return {
              status: "terminal",
              outcome: { status: "completed", result: { checks: count + 1 } },
            };
          item.checks += 1;
          item.lastCheckAt = host.now();
          if (error === undefined) {
            item.seen = remember(
              item.seen,
              found.map((f) => f.key),
            );
            item.lastFound = fresh.length;
            delete item.lastError;
          } else item.lastError = error;
          return { status: "running", checkpoint: { phase: "wait", at: next, count: count + 1 } };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", result: { checks: task.state.checkpoint.count } },
        }),
        context,
      );
    },
  });
}

/** A check as a model run with tools, in the watch's side conversation. */
async function checkWithModel(
  watch: Watch,
  count: number,
  nudge: ReturnType<ExtensionHost<unknown>["assistant"]>,
  runtime: TaskRuntime<TimerInput, TimerCheckpoint, { checks: number }, object>,
  context: Context,
): Promise<Report> {
  let sideId = watch.sideId;
  if (sideId === undefined) {
    sideId = await nudge.rooms.createSide(watch.roomId, context);
    const made = sideId;
    await runtime.commit(async (tx) => {
      const item = (await tx.doc(WatchesDoc, watch.roomId, null)).items.find(
        (i) => i.id === watch.id,
      );
      if (item !== undefined) item.sideId = made;
      return undefined;
    }, context);
  }
  const side = await nudge.harness.conversation(sideId as ConversationId, context);
  if (side === undefined) throw new Error(`Watch ${watch.id} lost its side conversation`);
  // Every check starts afresh: earlier checks' pages would only cost.
  await side.reset(undefined, context);
  const submission = await side.submit(
    {
      type: "input",
      content: checkPrompt(watch),
      whenBusy: "followUp",
      requestId: `watch:${watch.id}:${count}`,
    },
    context,
  );
  const settled = await submission.wait(context);
  if (settled.status !== "done") throw new Error(`the check ended ${settled.status}`);
  const report = parseReport(await lastReply(side, context));
  if (report === undefined) throw new Error("the check's reply had no items");
  // Only a script's message is posted as it is; the model tells the room itself.
  return { items: report.items };
}

/**
 * A check as a run of the watch's saved script, with no model: the run is a task this timer owns,
 * noted in the checkpoint first, so a rerun after a crash waits for the same run. The script's
 * tool calls answer the watch: private to its owner if it is private, else public.
 */
async function checkWithScript(
  watch: Watch,
  script: string,
  checkpoint: TimerCheckpoint,
  nudge: ReturnType<ExtensionHost<unknown>["assistant"]>,
  runtime: TaskRuntime<TimerInput, TimerCheckpoint, { checks: number }, object>,
  context: Context,
): Promise<Report> {
  let run = checkpoint.run as TaskId<ScriptRunResult> | undefined;
  // A run nothing registers would wait for its definition, and the watch with it: one a restart
  // left is stopped, and the check fails.
  if (!nudge.extensions().some((extension) => extension.name === "scripts")) {
    if (run !== undefined) await runtime.abortOwned(run, context);
    throw new Error(`script ${script} can't run: the scripts extension is off`);
  }
  if (run === undefined)
    await runtime.commit(async (tx) => {
      run = await tx.createTask(
        ScriptRun,
        {
          roomId: watch.roomId,
          name: script,
          callId: `watch:${watch.id}:${checkpoint.count}`,
          turn: watch.privateTo === undefined ? {} : { privateTo: watch.privateTo },
        },
        { ownership: { kind: "task", taskId: runtime.taskId } },
      );
      return { status: "running", checkpoint: { ...checkpoint, run: Number(run) } };
    }, context);
  const settled = await runtime.waitForTask(run!, context);
  const result = settled.state.outcome?.result;
  if (result === undefined || !result.ok)
    throw new Error(`script ${script} failed: ${result?.output.slice(0, 300) ?? "no result"}`);
  const report = parseReport(result.output);
  if (report === undefined) throw new Error(`script ${script} returned no items`);
  return report;
}

/** The text of the side conversation's latest answer. */
async function lastReply(side: Conversation, context: Context): Promise<string> {
  const { items } = await side.entries({ order: "descending" }, 20, undefined, context);
  for (const entry of items) {
    if (entry.kind !== "pi.assistant") continue;
    const message = entry.model?.find((m) => m.role === "assistant");
    const text = (message?.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (text.trim() !== "") return text;
  }
  return "";
}

/** The first check time after `now`, missed ones skipped. */
function nextCheck(at: number, every: number, now: number): number {
  if (at + every > now) return at + every;
  return at + every * (Math.floor((now - at) / every) + 1);
}

function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes >= 1440 && minutes % 1440 === 0)
    return minutes === 1440 ? "day" : `${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "minute" : `${minutes || "<1"} minutes`;
}

export default watchesExtension;
