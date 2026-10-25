import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type Approval,
  type Context,
  defineNudgeExtension,
  defineTool,
  type Model,
  type Models,
  requestApproval,
  roomOf,
  type ThinkingLevel,
  type Tx,
  Type,
} from "@nudge/core";
import {
  type DesktopAgentOptions,
  type DesktopAgentResult,
  DEFAULT_DESKTOP_MODEL,
  runDesktopAgent,
} from "./agent.ts";
import { foundApps } from "./apps.ts";
import { type LiveInput, startLiveView } from "./live.ts";
import { closeAllDesktops, holdDesktop, withDesktop } from "./pool.ts";
import { type DesktopOptions, desktopProblem, type PinnedAction } from "./session.ts";
import { type Viewer, viewersOf } from "./viewers.ts";

/**
 * What a `confirm` approval holds: the task a run stopped in, the action to approve, and that
 * action pinned to its tool, element and window, the one step approving it lets through.
 */
type ConfirmPayload = { task: string; action: string; step?: PinnedAction };

/**
 * Lets the assistant use desktop apps on Linux. The room's model delegates a task to
 * `use_desktop`; a desktop agent on its own, usually cheaper, model works the apps on a virtual
 * desktop of the room's own, through their accessibility tree as text, and returns the answer.
 * Its requests go through the assistant's redacting models like any other; it never sees pixels.
 */
export default defineNudgeExtension({
  name: "desktop",
  version: "0.1.0",
  apiVersion: "1.0",
  description: "Use desktop apps on a virtual Linux desktop, read as text by its own model",
  settings: Type.Object({
    /** The apps the agent may start, by name: the program and its arguments. Nothing else runs. */
    apps: Type.Record(Type.String(), Type.Array(Type.String(), { minItems: 1 }), {
      default: {},
      description:
        'The apps the desktop agent may start, by name: the program and its arguments, like "writer": ["libreoffice", "--writer"]. Left empty, the ones this server has of LibreOffice Writer and Calc, GNOME Text Editor and Dolphin.',
    }),
    /** Apps see the system's programs, their desktop's home and nothing else of the machine. */
    sandbox: Type.Boolean({
      default: true,
      description:
        "Run the apps in a bubblewrap sandbox, where they see only the system's programs and their desktop's own files, not the server's. Needs bubblewrap and user namespaces.",
    }),
    localNetwork: Type.Boolean({
      default: false,
      description:
        "Let the sandboxed apps reach the network as the server does: the local network and this machine's own services too, without slirp4netns. Off, they reach the internet only, through slirp4netns.",
    }),
    readable: Type.Array(Type.String(), {
      default: [],
      description:
        "More directories the sandboxed apps may read, such as where an app is installed outside /usr and /opt.",
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
    const set = settings.apps as Record<string, string[]>;
    const apps = Object.keys(set).length ? set : foundApps();
    const unavailable = `The desktop model "${settings.model}" is not available. Set "model" in the desktop extension's settings in nudge.json.`;

    /** One run of the desktop agent on a room's desktop: its own home, files and app settings. */
    const scopeOf = (conversationId: number) => `conversation-${conversationId}`;
    const problemOptions = { sandbox: settings.sandbox, localNetwork: settings.localNetwork };
    const optionsFor = (conversationId: number): DesktopOptions => ({
      apps,
      homeDir: join(homes(), scopeOf(conversationId)),
      ...(settings.sandbox
        ? { sandbox: { readable: settings.readable, localNetwork: settings.localNetwork } }
        : {}),
    });
    const useIn = async (
      run: { readonly models: Models; readonly conversationId: number; readonly context: Context },
      task: string,
      extra: Pick<DesktopAgentOptions, "approved" | "approvedStep" | "onStep">,
    ): Promise<DesktopAgentResult | string> => {
      const model = run.models.getModel(provider!, id.join("/")) as Model<Api> | undefined;
      if (!model) return unavailable;
      const problem = desktopProblem(problemOptions);
      if (problem) return problem;
      // People watching the desktop see what the agent does, as the room does.
      const viewers = viewersOf(scopeOf(run.conversationId));
      return withDesktop(optionsFor(run.conversationId), idleMs, async (desktop) => {
        try {
          return await runDesktopAgent({
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
            onStep: (step) => {
              if (step.type === "doing") viewers.broadcast({ type: "status", text: step.text });
              extra.onStep?.(step);
            },
          });
        } finally {
          viewers.broadcast({ type: "status", text: "" });
        }
      });
    };

    /**
     * Files an approval for the action a run stopped at. Approving it runs the task again on the
     * same room's desktop, allowed to do exactly that action (`approvals.confirm`).
     */
    const askToConfirm = (
      commit: <T>(apply: (tx: Tx) => Promise<T> | T) => Promise<T>,
      roomId: string,
      task: string,
      result: DesktopAgentResult,
    ): Promise<Approval> =>
      commit((tx) =>
        requestApproval(
          tx,
          roomId,
          {
            extension: "desktop",
            kind: "confirm",
            summary: `On the desktop: ${result.action ?? ""}`,
            payload: {
              task,
              action: result.action ?? "",
              ...(result.step ? { step: result.step } : {}),
            } satisfies ConfirmPayload,
          },
          now(),
        ),
      );

    const stopped = (result: DesktopAgentResult) =>
      `The desktop task stopped (${result.outcome}${result.error ? `: ${result.error}` : ""}) after ${result.steps} steps.${result.answer ? `\n${result.answer}` : ""}`;
    const names = Object.keys(apps);

    return {
      models: [{ provider: provider!, modelId: id.join("/") }],
      // For `nudge doctor`: what this server lacks for a desktop, and apps to run on it.
      problems: () => {
        const problem = desktopProblem(problemOptions);
        if (problem) return [problem];
        return Object.keys(apps).length
          ? []
          : [
              'No apps to run: this server has none of LibreOffice, GNOME Text Editor or Dolphin, and "apps" in the desktop extension\'s settings names none.',
            ];
      },
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
                result,
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
          const { task, action, step } = payload as ConfirmPayload;
          const result = await useIn(
            { models: run.models, conversationId: run.room.conversationId, context: run.context },
            task,
            { approved: action, ...(step ? { approvedStep: step } : {}) },
          );
          if (typeof result === "string") return { text: result, isError: true };
          if (result.outcome === "answered") return { text: result.answer, usage: result.usage };
          if (result.outcome === "needs-confirmation") {
            const next = await askToConfirm(run.commit, run.room.id, task, result);
            return {
              text: `${result.answer ? `${result.answer}\n` : ""}It stopped again before another step, which waits for approval ${next.id}: ${result.action}`,
              usage: result.usage,
            };
          }
          return { text: stopped(result), usage: result.usage, isError: true };
        },
      },
      // The room's desktop, live, for the people in the room: watch the agent, take over.
      roomSocket: async ({ room, player }, socket) => {
        const problem = desktopProblem(problemOptions);
        if (problem) throw new Error(problem);
        const viewers = viewersOf(scopeOf(room.conversationId));
        const { session, release } = await holdDesktop(optionsFor(room.conversationId), idleMs);
        const viewer: Viewer = {
          name: player.displayName,
          send: (output) => socket.send(JSON.stringify(output)),
        };
        // One stream per desktop, shared by its viewers, from the first who comes to the last.
        viewers.live ??= startLiveView(session, (output) => viewers.broadcast(output));
        const live = viewers.live;
        viewers.join(viewer);
        viewer.send({ type: "apps", apps: Object.keys(apps) });
        await live.welcome(viewer.send).catch(() => {});
        return {
          receive: (data) => {
            const input = JSON.parse(data) as LiveInput;
            if (input.type === "take") return viewers.take(viewer);
            // Only the one in control drives the desktop; the others watch.
            if (viewers.holder !== viewer)
              return viewer.send({
                type: "error",
                message: `${viewers.holder?.name ?? "Someone"} is using the desktop. Take control to use it.`,
              });
            live.receive(data, viewer.send);
          },
          close: () => {
            viewers.leave(viewer);
            if (viewers.size === 0) {
              live.close();
              if (viewers.live === live) viewers.live = undefined;
            }
            release();
          },
        };
      },
      // A reload or the assistant closing: the desktops close once their running tasks are done,
      // and open again, with the new settings, on the next task.
      close: () => (dataDir || temp ? closeAllDesktops(homes()) : undefined),
    };
  },
});
