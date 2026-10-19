import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Api, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Tx } from "@earendil-works/pi-durable";
import {
  type Approval,
  defineNudgeExtension,
  defineTool,
  requestApproval,
  roomOf,
  Type,
} from "@nudge/core";
import {
  type DesktopAgentOptions,
  type DesktopAgentResult,
  DEFAULT_DESKTOP_MODEL,
  runDesktopAgent,
} from "./agent.ts";
import { closeAllDesktops, withDesktop } from "./pool.ts";
import { desktopProblem } from "./session.ts";

/** What a `confirm` approval holds: the task a run stopped in, and the action to approve. */
type ConfirmPayload = { task: string; action: string };

/**
 * Lets the assistant use desktop apps on Linux. The room's model delegates a task to
 * `use_desktop`; a desktop agent on its own, usually cheaper, model works the apps on a virtual
 * desktop of the room's own, through their accessibility tree as text, and returns the answer.
 * Its requests go through the assistant's redacting models like any other; it never sees pixels.
 */
export default defineNudgeExtension({
  name: "desktop",
  version: "0.1.0",
  description: "Use desktop apps on a virtual Linux desktop, read as text by its own model",
  settings: Type.Object({
    /** The apps the agent may start, by name: the program and its arguments. Nothing else runs. */
    apps: Type.Record(Type.String(), Type.Array(Type.String(), { minItems: 1 }), {
      default: {},
      description:
        'The apps the desktop agent may start, by name: the program and its arguments, like "writer": ["libreoffice", "--writer"].',
    }),
    /** `provider/model` from the providers Nudge knows, such as `openai/gpt-5-mini`. */
    model: Type.String({
      default: DEFAULT_DESKTOP_MODEL,
      pattern: "^[^/]+/.+$",
      description:
        "The model that drives the desktop, as provider/model, such as openai/gpt-5-mini.",
    }),
    reasoning: Type.Union(
      [Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
      {
        default: "low",
        description:
          "How much the desktop model thinks before each step; more is slower and costs more.",
      },
    ),
    maxSteps: Type.Integer({
      default: 30,
      minimum: 1,
      maximum: 100,
      description: "Most model turns the desktop agent takes on one task before it gives up.",
    }),
    /** Close a room's desktop, and its apps, after this many minutes without a task. */
    idleMinutes: Type.Number({
      default: 10,
      minimum: 1,
      description: "Minutes without a task before a room's desktop and its apps are closed.",
    }),
  }),
  setup: ({ settings, dataDir, timeZone, now }) => {
    // Without a data directory (an in-memory assistant), homes go to a temp dir made on first use.
    let temp: string | undefined;
    const homes = () =>
      dataDir ? join(dataDir, "homes") : (temp ??= mkdtempSync(join(tmpdir(), "nudge-homes-")));
    const [provider, ...id] = settings.model.split("/");
    const idleMs = settings.idleMinutes * 60_000;
    const apps = settings.apps as Record<string, string[]>;
    const unavailable = `The desktop model "${settings.model}" is not available. Set "model" in the desktop extension's settings in nudge.json.`;

    /** One run of the desktop agent on a room's desktop: its own home, files and app settings. */
    const useIn = async (
      run: { readonly models: Models; readonly conversationId: number; readonly context: Context },
      task: string,
      extra: Pick<DesktopAgentOptions, "approved" | "onStep">,
    ): Promise<DesktopAgentResult | string> => {
      const model = run.models.getModel(provider!, id.join("/")) as Model<Api> | undefined;
      if (!model) return unavailable;
      const problem = desktopProblem();
      if (problem) return problem;
      return withDesktop(
        { apps, homeDir: join(homes(), `conversation-${run.conversationId}`) },
        idleMs,
        (desktop) =>
          runDesktopAgent({
            models: run.models,
            model,
            desktop,
            task,
            apps: Object.keys(apps),
            reasoning: settings.reasoning as ThinkingLevel,
            maxSteps: settings.maxSteps,
            timeZone,
            now,
            ...(run.context.abortSignal ? { signal: run.context.abortSignal } : {}),
            ...extra,
          }),
      );
    };

    /**
     * Files an approval for the action a run stopped at. Approving it runs the task again on the
     * same room's desktop, allowed to do exactly that action (`approvals.confirm`).
     */
    const askToConfirm = (
      commit: <T>(apply: (tx: Tx) => Promise<T> | T) => Promise<T>,
      roomId: string,
      task: string,
      action: string,
    ): Promise<Approval> =>
      commit((tx) =>
        requestApproval(
          tx,
          roomId,
          {
            extension: "desktop",
            kind: "confirm",
            summary: `On the desktop: ${action}`,
            payload: { task, action } satisfies ConfirmPayload,
          },
          now(),
        ),
      );

    const stopped = (result: DesktopAgentResult) =>
      `The desktop task stopped (${result.outcome}${result.error ? `: ${result.error}` : ""}) after ${result.steps} steps.${result.answer ? `\n${result.answer}` : ""}`;
    const names = Object.keys(apps);

    return {
      models: [{ provider: provider!, modelId: id.join("/") }],
      tools: [
        defineTool({
          name: "use_desktop",
          description: `Use desktop apps on a Linux desktop of this room's own: ${names.length ? names.join(", ") : "no apps are set up yet"}. A separate desktop agent does the task in the apps and returns its answer; files and app settings stay on that desktop between tasks. Give it a complete, self-contained task saying what to do and what to report. Prefer other tools when they can do the task; this is for apps with no better way in. Before it sends, deletes, pays, publishes or saves over a file it stops and asks the people in the room to approve that exact action; once approved, it carries on by itself.`,
          parameters: Type.Object({
            task: Type.String({ minLength: 1, description: "What to do and what to report back" }),
          }),
          execute: async ({ task }, api, context) => {
            // People in the room see the last line while it runs (`ToolPart.output`).
            api.output("Starting the desktop…\n");
            const result = await useIn(
              { models: api.models, conversationId: api.conversationId, context },
              task,
              {
                onStep: (step) => {
                  if (step.type === "doing") api.output(`${step.text}\n`);
                },
              },
            );
            if (typeof result === "string")
              return { output: [{ type: "text", text: result }], isError: true };
            const details = { steps: result.steps, actions: result.actions, model: settings.model };
            if (result.outcome === "needs-confirmation") {
              const room = await roomOf(api, api.conversationId, context);
              const approval = await askToConfirm(
                (apply) => api.commit(apply, context),
                room.id,
                task,
                result.action ?? "",
              );
              return {
                output: [
                  {
                    type: "text",
                    text: `The desktop agent stopped before this step and asked the room to approve it (approval ${approval.id}): ${result.action}\nOnce someone approves, it carries on by itself and the room hears how it went. Don't use the desktop for this again meanwhile.`,
                  },
                ],
                usage: result.usage,
                // `approval` puts Approve and Deny in the chat, as for any approval.
                details: { ...details, approval: approval.id },
              };
            }
            const answered = result.outcome === "answered";
            return {
              output: [{ type: "text", text: answered ? result.answer : stopped(result) }],
              isError: !answered,
              usage: result.usage,
              details,
            };
          },
        }),
      ],
      approvals: {
        // The action a `use_desktop` run stopped at, approved: the same task again, on the room's
        // desktop where the run left it, allowed to do exactly that.
        confirm: async (payload, run) => {
          const { task, action } = payload as ConfirmPayload;
          const result = await useIn(
            { models: run.models, conversationId: run.room.conversationId, context: run.context },
            task,
            { approved: action },
          );
          if (typeof result === "string") return { text: result, isError: true };
          if (result.outcome === "answered") return { text: result.answer, usage: result.usage };
          if (result.outcome === "needs-confirmation") {
            const next = await askToConfirm(run.commit, run.room.id, task, result.action ?? "");
            return {
              text: `${result.answer ? `${result.answer}\n` : ""}It stopped again before another step, which waits for approval ${next.id}: ${result.action}`,
              usage: result.usage,
            };
          }
          return { text: stopped(result), usage: result.usage, isError: true };
        },
      },
      // A reload or the assistant closing: the desktops close once their running tasks are done,
      // and open again, with the new settings, on the next task.
      close: () => (dataDir || temp ? closeAllDesktops(homes()) : undefined),
    };
  },
});
