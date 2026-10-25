import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  type Approval,
  type Context,
  currentTurn,
  defineNudgeExtension,
  defineTool,
  requestApproval,
  roomOf,
  type Tx,
  Type,
} from "@nudge/core";
import { roomDocuments } from "@nudge/ext-documents";
import { judge, type PolicyLists, type Verdict } from "./policy.ts";
import {
  type CommandResult,
  DESKTOP,
  type FileOptions,
  installed,
  MAX_MEMORY,
  MAX_WORKSPACE,
  megabytes,
  type Network,
  networkProblem,
  readFromSandbox,
  runSandboxed,
  sandboxProblem,
  WORKSPACE,
  writeToSandbox,
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

/** Types of files the workspace gives the documents, for their downloads; others have none. */
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".epub": "application/epub+zip",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

/**
 * Lets the assistant run shell commands in a terminal of the room's own: a bubblewrap sandbox with
 * the server's programs read-only and the room's workspace, and nothing else of the machine.
 * Every command is read first: what deletes or sends waits for the room's approval, what changes
 * the machine never runs, and the rest runs at once. Output goes to the model redacted, like any
 * tool's. Files move between the workspace and the room's documents, and the room's desktop's
 * files can be shared with it.
 */
export default defineNudgeExtension({
  name: "terminal",
  version: "0.1.0",
  apiVersion: "1.0",
  description: "Run shell commands in a sandboxed workspace of the room's own",
  settings: Type.Object({
    network: Type.Boolean({
      default: false,
      description:
        "Let commands reach the internet. They don't reach this machine's own services or the local network, unless localNetwork is on; that takes slirp4netns on the server. Commands that send data still ask first.",
    }),
    localNetwork: Type.Boolean({
      default: false,
      description:
        "With network on, let commands reach the network as the server does: the local network and this machine's own services too, without slirp4netns.",
    }),
    desktopFiles: Type.Boolean({
      default: false,
      description: `Let commands read and write the files of the room's desktop (its home, where the desktop extension's apps save) at ${DESKTOP}, such as to convert what Writer saved with pandoc.`,
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
    memoryMB: Type.Integer({
      default: megabytes(MAX_MEMORY),
      minimum: 64,
      description:
        "Most memory a command uses, in MB: all it starts together where the server's systemd gives it a cgroup, otherwise each of its programs on its own.",
    }),
    workspaceMB: Type.Integer({
      default: megabytes(MAX_WORKSPACE),
      minimum: 1,
      description:
        "Most a room's workspace holds, in MB. A command that grows it past that is stopped, and no document is copied in.",
    }),
  }),
  setup: ({ settings, dataDir, now, displayName, assistant }) => {
    // Without a data directory (an in-memory assistant), workspaces go to a temp dir.
    let temp: string | undefined;
    const workspaces = () =>
      dataDir
        ? join(dataDir, "workspaces")
        : (temp ??= mkdtempSync(join(tmpdir(), "nudge-workspaces-")));
    const network: Network = !settings.network ? "off" : settings.localNetwork ? "all" : "internet";
    // The desktop extension's home for the room, next to the workspaces; never made from here.
    const files = (conversationId: number): FileOptions => ({
      workspace: join(workspaces(), `conversation-${conversationId}`),
      ...(settings.desktopFiles && dataDir
        ? { desktop: join(dataDir, "..", "desktop", "homes", `conversation-${conversationId}`) }
        : {}),
      readable: settings.readable,
      maxWorkspaceBytes: settings.workspaceMB * 1024 ** 2,
    });
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
        ...files(conversationId),
        ...(cwd ? { cwd } : {}),
        network,
        timeoutMs: timeoutSeconds * 1000,
        maxOutput: MAX_OUTPUT,
        maxMemoryBytes: settings.memoryMB * 1024 ** 2,
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

    /** The room's documents, or why the terminal can't reach them. */
    const documentsOf = async (roomId: string, context: Context) => {
      const nudge = assistant();
      const documents = roomDocuments(nudge);
      return documents === undefined ||
        !(await nudge.extensionEnabled(roomId, "documents", context))
        ? "This room has no documents: the documents extension isn't on here."
        : documents;
    };

    return {
      problems: () => {
        const problem = sandboxProblem() ?? (network === "internet" ? networkProblem() : undefined);
        return problem ? [problem] : [];
      },
      tools: [
        defineTool({
          name: "run_command",
          description: `Run a shell command with bash in a terminal of this room's own: a sandboxed Linux workspace at ${WORKSPACE}, where files stay between commands, up to ${settings.workspaceMB} MB in all; a command gets ${settings.memoryMB} MB of memory. Each command starts a fresh shell in ${WORKSPACE} (or cwd), so chain steps with && or pass cwd. The basic tools for files, text and archives are there${tools.length ? `; of bigger ones, ${tools.join(", ")}` : ", but no bigger ones such as Python, Node or pandoc"}. ${network === "all" ? "It has the network." : network === "internet" ? "It has the internet, but not this machine's services or the local network." : "It has no network: downloads and installs fail."}${settings.desktopFiles ? ` The room's desktop's files (where its apps save) are at ${DESKTOP}.` : ""} document_to_workspace and workspace_to_documents move files between it and the room's documents. Commands that delete files, send data or connect elsewhere, or run programs not on its list, wait for the room's approval; some, like sudo, never run. Output is cut to its start and end past ${MAX_OUTPUT} characters, so filter long output (grep, head, tail).`,
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
            const verdict = afterUntrusted(judge(command, lists), network);
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
                output: [{ type: "text", text: describe(result, limit, settings.workspaceMB) }],
                isError: result.exitCode !== 0,
                details: {
                  exitCode: result.exitCode ?? null,
                  timedOut: result.timedOut,
                  workspaceFull: result.workspaceFull,
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
        defineTool({
          name: "document_to_workspace",
          description: `Copy one of this room's documents (the files people uploaded; list_documents gives their ids) into the terminal's workspace, to work on it with run_command. It never replaces a file there.`,
          parameters: Type.Object({
            id: Type.String({ description: "The document's id, such as d3" }),
            path: Type.Optional(
              Type.String({
                description: `Where to put it, in ${WORKSPACE} or relative to it; its name in ${WORKSPACE} if not given`,
              }),
            ),
          }),
          execute: async ({ id, path }, api, context) => {
            const problem = sandboxProblem();
            if (problem) return failure(problem);
            const room = await roomOf(api, api.conversationId, context);
            const documents = await documentsOf(room.id, context);
            if (typeof documents === "string") return failure(documents);
            const info = (await documents.list(room.id, context)).find((item) => item.id === id);
            if (info === undefined) return failure(`No document ${id} here.`);
            try {
              const bytes = await documents.file(room.id, info.id);
              const saved = await writeToSandbox(
                path ?? info.name,
                bytes,
                files(api.conversationId),
              );
              return text(`Copied ${info.id} (${info.name}, ${bytes.length} bytes) to ${saved}.`);
            } catch (error) {
              return failure(`Could not copy it: ${(error as Error).message}`);
            }
          },
        }),
        defineTool({
          name: "workspace_to_documents",
          description: `Add a file from the terminal's workspace${settings.desktopFiles ? ` or ${DESKTOP}` : ""} to this room's documents, where people download it from the room's Documents page. Use it to hand over what you made, such as a converted PDF or a spreadsheet.`,
          parameters: Type.Object({
            path: Type.String({
              description: `The file, in ${WORKSPACE} or relative to it`,
            }),
            name: Type.Optional(
              Type.String({
                description: "Its name among the documents; the file's own if not given",
              }),
            ),
          }),
          execute: async ({ path, name }, api, context) => {
            const problem = sandboxProblem();
            if (problem) return failure(problem);
            const room = await roomOf(api, api.conversationId, context);
            const documents = await documentsOf(room.id, context);
            if (typeof documents === "string") return failure(documents);
            const named = name?.trim() || basename(path);
            try {
              const bytes = await readFromSandbox(
                path,
                files(api.conversationId),
                documents.maxBytes,
              );
              const info = await documents.add(
                room.id,
                named,
                MIME_TYPES[extname(named).toLowerCase()] ?? "",
                bytes,
                displayName,
              );
              return text(
                `Added ${path} to the room's documents as ${info.id} (${info.name}); people download it from the Documents page.`,
              );
            } catch (error) {
              return failure(`Could not add it: ${(error as Error).message}`);
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
            text: `Ran \`${command}\`:\n${describe(result, settings.timeoutSeconds, settings.workspaceMB)}`,
            isError: result.exitCode !== 0,
          };
        },
      },
    };
  },
});

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

/** A command's output and how it ended, for the model. */
function describe(result: CommandResult, timeoutSeconds: number, workspaceMB: number): string {
  const ending = result.timedOut
    ? `stopped: it ran longer than ${timeoutSeconds} seconds`
    : result.workspaceFull
      ? `stopped: it filled the workspace past its ${workspaceMB} MB; delete files from it`
      : result.aborted
        ? "stopped"
        : `exit code ${result.exitCode}`;
  return `${result.output.trimEnd() || "(no output)"}\n\n(${ending})`;
}

/**
 * A command that would run freely asks first when the turn read untrusted data and the terminal
 * has the network: whatever it runs could send that data out (ADR 20).
 */
function afterUntrusted(verdict: Verdict, network: Network): Verdict {
  const { untrusted } = currentTurn();
  if (verdict.kind !== "run" || network === "off" || untrusted === undefined) return verdict;
  return {
    kind: "ask",
    reasons: [
      `this turn read untrusted data (${untrusted.join(", ")}) and the terminal has the network`,
    ],
  };
}
