import type { Context } from "@earendil-works/chord";
import {
  defineTask,
  type JsonObject,
  NestedCallDoc,
  type NestedToolExecutionResult,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
  type ToolRegistration,
  ToolTask,
  type ToolTaskResult,
} from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { CappedSandbox } from "@nudge/ext-codemode";
import {
  canRead,
  currentTurn,
  defineNudgeExtension,
  defineTool,
  keepsPlaceholders,
  onlyReads,
  roomOf,
  section,
  Type,
} from "@nudge/core";
import { MAX_CODE, NAME, type Script, ScriptsDoc, withArgs } from "./model.ts";

const VERSION = "0.1.0";

/**
 * The tool that runs a script's code: code mode's, with only the tools that read. Not for the
 * model, which runs scripts by name; `run_script` and `ScriptRun` call it.
 */
export const EXEC_TOOL = "script_exec";

const Settings = Type.Object({
  timeoutSeconds: Type.Number({
    default: 30,
    minimum: 1,
    maximum: 600,
    description: "Seconds a script may run, including the time its tool calls take.",
  }),
  memoryMb: Type.Number({
    default: 64,
    minimum: 8,
    maximum: 1024,
    description: "Megabytes of memory a script may use.",
  }),
  maxPerRoom: Type.Number({
    default: 20,
    minimum: 1,
    description: "Most scripts one room may keep.",
  }),
});

/** Who a script saved now is private to, if the turn is private. */
function privately(): { privateTo?: { playerId: string; displayName: string } } {
  const { privateTo } = currentTurn();
  return privateTo === undefined ? {} : { privateTo: { ...privateTo } };
}

/** A private script exists only in its owner's private turns. */
function visible(script: Script): boolean {
  return (
    script.privateTo === undefined ||
    script.privateTo.playerId === currentTurn().privateTo?.playerId
  );
}

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError } : {}),
});

/** The text a run returned: code mode's report of the script's output. */
export function outputOf(
  result: Pick<NestedToolExecutionResult, "structuredOutput" | "diagnostics">,
): string {
  // A schema-less tool's output: one text, or a list of its parts.
  const value = result.structuredOutput;
  const said = Array.isArray(value)
    ? value
        .map((part) => {
          const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
          return type === "text" && typeof text === "string" ? text : "";
        })
        .join("")
    : typeof value === "string"
      ? value
      : "";
  return said !== "" ? said : result.diagnostics.map((d) => d.message).join("\n");
}

/**
 * The api with only the tools that read: the script sees just those, and a call of any other tool,
 * or a reading tool called to change something, is refused before it runs.
 */
function readingOnly(api: ToolExecutionApi): ToolExecutionApi {
  const agent: ToolExecutionApi["agent"] = async (context) => {
    const full = await api.agent(context);
    return { ...full, callable: full.callable.filter((tool) => canRead(tool as ToolRegistration)) };
  };
  return {
    ...api,
    agent,
    executeTool: async (name, args, context, options) => {
      const tool = (await api.agent(context)).callable.find((t) => t.name === name);
      if (tool === undefined || !onlyReads(tool as ToolRegistration, args))
        return {
          taskId: 0 as TaskId,
          isError: true,
          diagnostics: [
            {
              severity: "error",
              code: "blocked",
              message: `Scripts only read: ${name} can't be called from a script.`,
            },
          ],
        };
      return api.executeTool(name, args, context, options);
    },
  };
}

export type ScriptRunInput = {
  roomId: string;
  name: string;
  args?: JsonObject;
  /** Names the run's tool call, like `watch:w1:3`; unique per run. */
  callId: string;
};
export type ScriptRunResult = { ok: boolean; output: string };

/**
 * One run of a saved script, out of any turn: for watches and other timers. Create it owned by
 * the task that waits for it; its result is the script's output. Reruns after a restart reattach
 * to the script's call, which code mode resumes.
 */
export const ScriptRun = defineTask<ScriptRunInput, { phase: "run" }, ScriptRunResult>({
  name: "scripts.run",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      const { roomId, name, args, callId } = task.input;
      const script = (await runtime.snapshot(ScriptsDoc, roomId, context))?.items.find(
        (item) => item.name === name,
      );
      const result =
        script === undefined
          ? undefined
          : await callNested(
              runtime,
              callId,
              EXEC_TOOL,
              { code: withArgs(script.code, args) },
              context,
            );
      const ok = result !== undefined && !result.isError;
      const output = result === undefined ? `No script ${name} in this room.` : outputOf(result);
      return runtime.commit(async (tx) => {
        const item = (await tx.doc(ScriptsDoc, roomId, null)).items.find((i) => i.name === name);
        if (item !== undefined) counted(item, ok, output, Date.now());
        return {
          status: "terminal",
          outcome: { status: "completed", result: { ok, output } },
        };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({
        status: "terminal",
        outcome: { status: "aborted", result: { ok: false, output: "The run was stopped." } },
      }),
      context,
    );
  },
});

/** Counts a run on its script. */
function counted(script: Script, ok: boolean, output: string, now: number): void {
  script.runs += 1;
  script.lastRunAt = now;
  if (ok) delete script.lastError;
  else script.lastError = output.slice(0, 300);
}

/**
 * A nested tool call made by a task, as `executeTool` makes one for a tool: its tool task and
 * `NestedCallDoc` in one commit, so a rerun finds the call it already made.
 */
async function callNested(
  runtime: TaskRuntime<unknown, unknown, unknown, object>,
  parentCallId: string,
  name: string,
  args: JsonObject,
  context: Context,
): Promise<NestedToolExecutionResult> {
  const key = "exec";
  let id: TaskId<ToolTaskResult> | undefined;
  await runtime.commit(async (tx) => {
    const state = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
    if (state.taskId !== undefined) {
      id = state.taskId;
      return undefined;
    }
    id = await tx.createTask(
      ToolTask,
      {
        kind: "nested",
        parent: runtime.taskId,
        parentCallId,
        key,
        call: { type: "toolCall", id: `${parentCallId}/${key}`, name, arguments: args },
      },
      { ownership: { kind: "task", taskId: runtime.taskId } },
    );
    state.taskId = id;
    return undefined;
  }, context);
  await runtime.waitForTask(id!, context);
  const stored = (await runtime.snapshot(NestedCallDoc, runtime.taskId, key, context))?.result;
  return (
    (stored as NestedToolExecutionResult | undefined) ?? {
      taskId: id!,
      isError: true,
      diagnostics: [{ severity: "error", message: `${name} ended without a result.` }],
    }
  );
}

export const scriptsExtension = defineNudgeExtension({
  name: "scripts",
  version: VERSION,
  description:
    "Scripts: the assistant saves small programs for checks it repeats, and runs them again without spending a model turn.",
  settings: Settings,
  setup: (host) => {
    const { timeoutSeconds, memoryMb, maxPerRoom } = host.settings;
    const sandbox = new CappedSandbox(timeoutSeconds * 1000, memoryMb * 2 ** 20);
    const codemode = createCodemodeTool({ sandbox, models: false });

    const exec = defineTool({
      name: EXEC_TOOL,
      description: "Runs a saved script's code with the tools that read. Use run_script instead.",
      parameters: Type.Object({ code: Type.String() }),
      callers: ["tools"],
      replay: "safe",
      ...(codemode.outputLimits === undefined ? {} : { outputLimits: codemode.outputLimits }),
      execute: (args, api, context) => codemode.execute(args, readingOnly(api), context),
    });

    const scriptsOf = async (api: ToolExecutionApi, context: Context) => {
      const room = await roomOf(api, api.conversationId, context);
      const items = (await api.snapshot(ScriptsDoc, room.id, context))?.items ?? [];
      return { room, items: items.filter(visible) };
    };

    const save = defineTool({
      name: "save_script",
      description:
        "Save a short JavaScript program to run again later with run_script or from a watch, " +
        "instead of working out the same steps each time. It runs like code mode: `await " +
        "tools.<name>(args)` calls this room's tools that only read (searches, feeds, reading " +
        "mail, GET calls of connectors); nothing that changes something. `args` holds what " +
        "run_script passes. Return what it found. A script a watch runs returns " +
        '{"items":[{"key":"…","text":"…"}]}, and may add "message" to have that text posted ' +
        "to the room as it is, without you. It runs once now as a test; it is saved only if " +
        "that works. Saving under a name already used replaces that script.",
      parameters: Type.Object({
        name: Type.String({ description: "Lower case words joined by dashes, like finn-glc." }),
        description: Type.String({ description: "What it does and what it returns." }),
        code: Type.String({ description: "The JavaScript." }),
        test_args: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), { description: "`args` for the test run." }),
        ),
      }),
      execute: async (args, api, context) => {
        const name = args.name.trim();
        if (!NAME.test(name)) return text("Name it in lower case words joined by dashes.", true);
        if (args.code.length > MAX_CODE)
          return text(`Keep a script under ${MAX_CODE} characters.`, true);
        const { room, items } = await scriptsOf(api, context);
        const taken = items.some((item) => item.name === name);
        if (!taken && items.length >= maxPerRoom)
          return text(`This conversation keeps ${maxPerRoom} scripts already.`, true);
        const tried = await api.executeTool(
          EXEC_TOOL,
          { code: withArgs(args.code, args.test_args) },
          context,
          { key: "test" },
        );
        const output = outputOf(tried);
        if (tried.isError) return text(`Not saved: the test run failed.\n${output}`, true);
        const now = host.now();
        await api.commit(async (tx) => {
          const state = await tx.doc(ScriptsDoc, room.id, null);
          const before = state.items.find((item) => item.name === name);
          const script: Script = {
            name,
            description: args.description.trim(),
            code: args.code,
            createdAt: before?.createdAt ?? now,
            updatedAt: now,
            runs: 1,
            lastRunAt: now,
            ...privately(),
          };
          state.items = [...state.items.filter((item) => item.name !== name), script];
        }, context);
        return text(`${taken ? "Replaced" : "Saved"} script ${name}. The test run:\n${output}`);
      },
    });

    const run = defineTool({
      name: "run_script",
      description: "Run one of this conversation's saved scripts and get what it returns.",
      parameters: Type.Object({
        name: Type.String({ description: "From the scripts section." }),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { room, items } = await scriptsOf(api, context);
        const script = items.find((item) => item.name === args.name);
        if (script === undefined) return text(`No script ${args.name} in this conversation.`, true);
        const result = await api.executeTool(
          EXEC_TOOL,
          { code: withArgs(script.code, args.args) },
          context,
          { key: "run" },
        );
        const output = outputOf(result);
        await api.commit(async (tx) => {
          const item = (await tx.doc(ScriptsDoc, room.id, null)).items.find(
            (i) => i.name === script.name,
          );
          if (item !== undefined) counted(item, !result.isError, output, host.now());
        }, context);
        return text(output, result.isError);
      },
    });

    const list = defineTool({
      name: "list_scripts",
      description: "List this conversation's saved scripts with how their runs went.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, context) => {
        const { items } = await scriptsOf(api, context);
        return text(
          items.length === 0
            ? "No scripts."
            : items
                .map(
                  (s) =>
                    `${s.name}: ${s.description} (${s.runs} runs` +
                    (s.lastError === undefined ? "" : `, last run failed: ${s.lastError}`) +
                    ")",
                )
                .join("\n"),
        );
      },
    });

    const show = defineTool({
      name: "show_script",
      description: "Show a saved script's code, to fix or change it.",
      parameters: Type.Object({ name: Type.String() }),
      replay: "safe",
      execute: async (args, api, context) => {
        const script = (await scriptsOf(api, context)).items.find((s) => s.name === args.name);
        return script === undefined
          ? text(`No script ${args.name} in this conversation.`, true)
          : text(`${script.name}: ${script.description}\n\n${script.code}`);
      },
    });

    const remove = defineTool({
      name: "remove_script",
      description: "Delete one of this conversation's saved scripts.",
      parameters: Type.Object({ name: Type.String() }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { room, items } = await scriptsOf(api, context);
        if (!items.some((s) => s.name === args.name))
          return text(`No script ${args.name} in this conversation.`, true);
        await api.commit(async (tx) => {
          const state = await tx.doc(ScriptsDoc, room.id, null);
          state.items = state.items.filter((item) => item.name !== args.name);
        }, context);
        return text(`Removed script ${args.name}.`);
      },
    });

    return {
      tasks: [ScriptRun],
      // Scripts are kept as the model wrote them, with placeholders; the code runs with the values.
      tools: [exec, keepsPlaceholders(save), run, list, show, remove],
      sections: [
        section("scripts", async (input, context) => {
          const room = await roomOf(input.read, input.conversationId, context).catch(
            () => undefined,
          );
          if (room === undefined) return undefined;
          const items = (
            (await input.read.snapshot(ScriptsDoc, room.id, context))?.items ?? []
          ).filter(visible);
          return [
            "When you'd do the same lookup or check again (often for a watch), save it with " +
              "save_script and run it by name, rather than working out the steps every time.",
            ...(items.length === 0
              ? []
              : [
                  "Saved scripts of this conversation:",
                  ...items.map((script) => `- ${script.name}: ${script.description}`),
                ]),
          ].join("\n");
        }),
      ],
      close: () => sandbox.close(),
    };
  },
});

export default scriptsExtension;
