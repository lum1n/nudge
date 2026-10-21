import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tx } from "@earendil-works/pi-durable";
import {
  type Approval,
  defineNudgeExtension,
  defineTool,
  requestApproval,
  roomOf,
  Type,
} from "@nudge/core";
import { judge, type PolicyLists } from "./policy.ts";
import {
  type CommandResult,
  installed,
  runSandboxed,
  sandboxProblem,
  WORKSPACE,
} from "./sandbox.ts";

/** What a `run` approval holds: the command to run once approved, and where. */
type RunPayload = { command: string; cwd?: string };

/** What a call's `details` says: the approval it waits for, or how the command ended. */
type Details = Record<string, string | number | boolean | null>;

/** Most characters of a command's output the model gets: its start and its end. */
const MAX_OUTPUT = 30_000;

/** Bigger tools the model is told about when the server has them; servers differ the most here. */
const NOTABLE = [
  "git",
  "python3",
  "node",
  "pandoc",
  "ffmpeg",
  "convert",
  "pdftotext",
  "sqlite3",
  "jq",
  "curl",
];

/**
 * Lets the assistant run shell commands in a terminal of the room's own: a bubblewrap sandbox with
 * the server's programs read-only and the room's workspace, and nothing else of the machine.
 * Every command is read first: what deletes or sends waits for the room's approval, what changes
 * the machine never runs, and the rest runs at once. Output goes to the model redacted, like any
 * tool's.
 */
export default defineNudgeExtension({
  name: "terminal",
  version: "0.1.0",
  description: "Run shell commands in a sandboxed workspace of the room's own",
  settings: Type.Object({
    network: Type.Boolean({
      default: false,
      description:
        "Let commands reach the network, as the server does: the internet, and the local network and this machine's own services too. Commands that send data still ask first.",
    }),
    allow: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      description:
        "More programs that run without asking, by name. A program here runs however it is called, even one the terminal would ask about or refuse.",
    }),
    ask: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      description: "Programs that run only once someone in the room approves the command.",
    }),
    deny: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      description: "Programs that never run.",
    }),
    readable: Type.Array(Type.String(), {
      default: [],
      description:
        "More directories commands may read, at the same paths, such as where a tool is installed outside /usr and /opt.",
    }),
    timeoutSeconds: Type.Integer({
      default: 60,
      minimum: 1,
      maximum: 600,
      description: "Longest a command may run before it is stopped.",
    }),
  }),
  setup: ({ settings, dataDir, now }) => {
    // Without a data directory (an in-memory assistant), workspaces go to a temp dir.
    let temp: string | undefined;
    const workspaces = () =>
      dataDir
        ? join(dataDir, "workspaces")
        : (temp ??= mkdtempSync(join(tmpdir(), "nudge-workspaces-")));
    const lists: PolicyLists = {
      allow: settings.allow,
      ask: settings.ask,
      deny: settings.deny,
    };

    const run = (
      conversationId: number,
      { command, cwd }: RunPayload,
      timeoutSeconds: number,
      extra: { signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
    ): Promise<CommandResult> =>
      runSandboxed(command, {
        workspace: join(workspaces(), `conversation-${conversationId}`),
        ...(cwd ? { cwd } : {}),
        network: settings.network,
        readable: settings.readable,
        timeoutMs: timeoutSeconds * 1000,
        maxOutput: MAX_OUTPUT,
        ...extra,
      });

    const askToRun = (
      commit: <T>(apply: (tx: Tx) => Promise<T> | T) => Promise<T>,
      roomId: string,
      payload: RunPayload,
      reasons: readonly string[],
    ): Promise<Approval> =>
      commit((tx) =>
        requestApproval(
          tx,
          roomId,
          {
            extension: "terminal",
            kind: "run",
            summary: `In the terminal (${reasons.join("; ")}): ${payload.command}`,
            payload,
          },
          now(),
        ),
      );

    const tools = installed(NOTABLE);

    return {
      problems: () => {
        const problem = sandboxProblem();
        return problem ? [problem] : [];
      },
      tools: [
        defineTool({
          name: "run_command",
          description: `Run a shell command with bash in a terminal of this room's own: a sandboxed Linux workspace at ${WORKSPACE}, where files stay between commands. Each command starts a fresh shell in ${WORKSPACE} (or cwd), so chain steps with && or pass cwd. The basic tools for files, text and archives are there${tools.length ? `; of bigger ones, ${tools.join(", ")}` : ", but no bigger ones such as Python, Node or pandoc"}. ${settings.network ? "It has the network." : "It has no network: downloads and installs fail."} Commands that delete files, send data or connect elsewhere, or run programs not on its list, wait for the room's approval; some, like sudo, never run. Output is cut to its start and end past ${MAX_OUTPUT} characters, so filter long output (grep, head, tail).`,
          parameters: Type.Object({
            command: Type.String({ minLength: 1, description: "The bash command to run" }),
            cwd: Type.Optional(
              Type.String({ description: `Working directory, in ${WORKSPACE} or relative to it` }),
            ),
            timeoutSeconds: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: settings.timeoutSeconds,
                description: `Seconds before it is stopped, at most ${settings.timeoutSeconds}`,
              }),
            ),
          }),
          execute: async ({ command, cwd, timeoutSeconds }, api, context) => {
            const problem = sandboxProblem();
            if (problem) return { output: [{ type: "text", text: problem }], isError: true };
            const payload: RunPayload = { command, ...(cwd ? { cwd } : {}) };
            const verdict = judge(command, lists);
            if (verdict.kind === "deny")
              return {
                output: [
                  {
                    type: "text",
                    text: `Not run: ${verdict.reasons.join("; ")}. Do it another way, or not at all.`,
                  },
                ],
                isError: true,
              };
            if (verdict.kind === "ask") {
              const room = await roomOf(api, api.conversationId, context);
              const approval = await askToRun(
                (apply) => api.commit(apply, context),
                room.id,
                payload,
                verdict.reasons,
              );
              return {
                output: [
                  {
                    type: "text",
                    text: `Not run yet: the room has to approve it first (approval ${approval.id}), because ${verdict.reasons.join("; ")}. Once someone approves, it runs and the room hears its output. Don't run it again meanwhile.`,
                  },
                ],
                // `approval` puts Approve and Deny in the chat, as for any approval.
                details: { approval: approval.id } as Details,
              };
            }
            const limit = Math.min(
              timeoutSeconds ?? settings.timeoutSeconds,
              settings.timeoutSeconds,
            );
            try {
              const result = await run(api.conversationId, payload, limit, {
                ...(context.abortSignal ? { signal: context.abortSignal } : {}),
                // People in the room see the output while it runs (`ToolPart.output`).
                onOutput: (chunk) => api.output(chunk),
              });
              return {
                output: [{ type: "text", text: describe(result, limit) }],
                isError: result.exitCode !== 0,
                details: {
                  exitCode: result.exitCode ?? null,
                  timedOut: result.timedOut,
                } as Details,
              };
            } catch (error) {
              return {
                output: [{ type: "text", text: `Could not run it: ${(error as Error).message}` }],
                isError: true,
              };
            }
          },
        }),
      ],
      approvals: {
        // A command the room approved: run as it was asked, unless the settings now refuse it.
        run: async (payload, approved) => {
          const { command, cwd } = payload as RunPayload;
          const problem = sandboxProblem();
          if (problem) return { text: problem, isError: true };
          const verdict = judge(command, lists);
          if (verdict.kind === "deny")
            return { text: `Not run: ${verdict.reasons.join("; ")}.`, isError: true };
          const result = await run(
            approved.room.conversationId,
            { command, ...(cwd ? { cwd } : {}) },
            settings.timeoutSeconds,
            approved.context.abortSignal ? { signal: approved.context.abortSignal } : {},
          );
          return {
            text: `Ran \`${command}\`:\n${describe(result, settings.timeoutSeconds)}`,
            isError: result.exitCode !== 0,
          };
        },
      },
    };
  },
});

/** A command's output and how it ended, for the model. */
function describe(result: CommandResult, timeoutSeconds: number): string {
  const ending = result.timedOut
    ? `stopped: it ran longer than ${timeoutSeconds} seconds`
    : result.aborted
      ? "stopped"
      : `exit code ${result.exitCode}`;
  return `${result.output.trimEnd() || "(no output)"}\n\n(${ending})`;
}
