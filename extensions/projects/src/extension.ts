import {
  actingFor,
  type ApprovalDraft,
  BACKGROUND_CONTEXT,
  type Context,
  type ConversationId,
  currentTurn,
  defineNudgeExtension,
  defineTool,
  type ExtensionAssistant,
  type ExtensionDocuments,
  FIRE_ENTRY,
  type FireEntryData,
  readsOnly,
  requestApproval,
  roomOf,
  type RoomSocketHandler,
  scrubSecrets,
  section,
  SpendDoc,
  type ToolExecutionApi,
  Type,
  type UiCard,
} from "@nudge/core";
import { type AccApi, accApi } from "@nudge/ext-acc";
import { randomBytes } from "node:crypto";
import { projectCard } from "./card.ts";
import {
  activateNext,
  activeMilestone,
  describePlan,
  findTask,
  milestoneReady,
  newProject,
  type PlanDraft,
  type Project,
  ProjectDoc,
  ProjectError,
  projectIn,
  ready,
  running,
  setPlan,
  type Task,
  tasksOf,
  vmName,
} from "./model.ts";
import {
  ACCOUNT_SECRETS,
  bootstrapScript,
  ciOf,
  envFile,
  mergeScript,
  prsScript,
  SECRET_NAME,
  worktreeScript,
  WRITE_CODEX_AUTH,
  WRITE_ENV,
} from "./vm.ts";

const VERSION = "0.1.0";
const context = BACKGROUND_CONTEXT;
const ACCOUNT = "account";
/** Characters of a script's output a tool gives the model. */
const MAX_OUTPUT = 3_000;

const Settings = Type.Object({
  maxAgents: Type.Number({
    default: 2,
    minimum: 1,
    maximum: 8,
    description: "How many coding agents may work on one project at once.",
  }),
  harness: Type.Union([Type.Literal("claude"), Type.Literal("codex")], {
    default: "claude",
    description: "The agent that builds tasks: claude (Claude Code) or codex.",
  }),
  reviewHarness: Type.Union([Type.Literal("claude"), Type.Literal("codex")], {
    default: "codex",
    description: "The agent that reviews a finished task before its milestone is merged.",
  }),
  vmUser: Type.String({
    default: "exedev",
    description: "The user agents run as on a project's exe.dev VM, unless exe.dev says another.",
  }),
  vmImage: Type.Optional(
    Type.String({ description: "The image new project VMs run; exe.dev's default when left out." }),
  ),
  stallMinutes: Type.Number({
    default: 20,
    minimum: 1,
    description: "How long an agent may be quiet before the assistant checks on it.",
  }),
  digestHour: Type.Number({
    default: 9,
    minimum: 0,
    maximum: 23,
    description: "The hour of the day, in the assistant's time zone, a project's digest goes out.",
  }),
  wakesPerHour: Type.Number({
    default: 20,
    minimum: 1,
    description: "At most this many times an hour the extension wakes a project's supervisor.",
  }),
  budgetWarnAt: Type.Number({
    default: 0.8,
    minimum: 0.1,
    maximum: 1,
    description: "The share of a project's budget at which it pauses and asks whether to go on.",
  }),
});

export type ProjectsOptions = {
  /** How often stalls, digests and ready tasks are checked; default a minute. Tests go faster. */
  readonly tickMs?: number;
  /** Random VM name endings; tests pass fixed ones. */
  readonly random?: () => string;
  readonly report?: (error: unknown) => void;
};

/** A task as the panel shows it. */
export type TaskView = Omit<Task, "milestone" | "heardAt" | "checkedAt" | "session"> & {
  session?: { host: string; id: string; state?: string };
};

/** A project as the panel shows it. */
export type ProjectView = {
  id: string;
  name: string;
  status: Project["status"];
  brief: string;
  repo?: string;
  milestones: { id: string; title: string; status: string; tasks: TaskView[] }[];
  vm?: { name: string; host: string; ready: boolean };
  secrets: string[];
  spendUsd: number;
  budgetUsd?: number;
  maxAgents: number;
  updatedAt: number;
};

/** What the panel socket sends. `ref` echoes the input's. */
export type PanelOutput =
  | { type: "project"; project: ProjectView | null }
  | { type: "ok"; ref?: string }
  | { type: "error"; message: string; ref?: string };

/** What it takes. */
export type PanelInput = { ref?: string } & ({ type: "pause" } | { type: "resume" });

function text(value: string, isError = false) {
  return { output: [{ type: "text" as const, text: value }], ...(isError ? { isError } : {}) };
}

function cut(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** `YYYY-MM` of `at` in `timeZone`, as spending keys months. */
function monthOf(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" })
    .formatToParts(at)
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}`;
}

/** The next time it is `hour` o'clock in `timeZone` after `now`. */
export function nextHour(now: number, hour: number, timeZone: string): number {
  const hourOf = (at: number) =>
    Number(
      new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at),
    );
  // Steps by the hour to the next one with the right hour; time zones shift by whole hours here.
  let at = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  for (let i = 0; i < 48 && hourOf(at) !== hour; i++) at += 3_600_000;
  return at;
}

/** The prompt a building agent starts with. */
export function taskPrompt(project: Project, task: Task): string {
  return [
    `You are working on task ${task.id} of the project "${project.name}": ${task.title}`,
    "",
    task.criteria.length === 0
      ? "Done means it works and is tested."
      : `Done means:\n${task.criteria.map((line) => `- ${line}`).join("\n")}`,
    "",
    `About the project:\n${cut(project.brief, 2_000) || "(no brief)"}`,
    "",
    "How to work:",
    `- This directory is a git worktree on branch task/${task.id}. Keep to this task; commit as you go.`,
    "- The project's secrets are in your environment, from ~/.nudge/project.env (`set -a; . ~/.nudge/project.env; set +a` if not). Never print, log or commit them.",
    `- When it is done, run the tests, push (git push -u origin task/${task.id}) and open a pull request with \`gh pr create --fill\`. Don't merge it.`,
    "- End your last turn with one line: `DONE <the PR's URL>`, or `BLOCKED <why>` if you can't go on without a person.",
    "- If you have a question, ask it and stop; someone will answer.",
  ].join("\n");
}

/** The prompt a reviewing agent starts with. */
export function reviewPrompt(project: Project, task: Task): string {
  return [
    `Review the pull request ${task.pr?.url ?? `on branch task/${task.id}`} for task ${task.id} of "${project.name}": ${task.title}`,
    "",
    task.criteria.length === 0
      ? "It should work and be tested."
      : `It must meet:\n${task.criteria.map((line) => `- ${line}`).join("\n")}`,
    "",
    "Read the diff, run the tests, and check each point. Fix small problems yourself, commit and push them to the same branch. Never merge.",
    "End with one line: `REVIEWED ok`, or `REVIEWED changes: <what is still wrong>`.",
  ].join("\n");
}

/** Every open panel, per room, so a change from anywhere reaches them all. */
class Panels {
  private readonly viewers = new Map<string, Set<(data: string) => void>>();

  constructor(
    private readonly view: (roomId: string) => Promise<ProjectView | null>,
    private readonly act: (roomId: string, input: PanelInput) => Promise<void>,
  ) {}

  /** Sends the room's project to its open panels. Never fails. */
  async changed(roomId: string): Promise<void> {
    const viewers = this.viewers.get(roomId);
    if (viewers === undefined || viewers.size === 0) return;
    try {
      const frame = JSON.stringify({
        type: "project",
        project: await this.view(roomId),
      } satisfies PanelOutput);
      for (const send of viewers) send(frame);
    } catch {
      // The next change sends it again.
    }
  }

  readonly roomSocket: RoomSocketHandler = async ({ room }, socket) => {
    const send = (data: string) => socket.send(data);
    const reply = (output: PanelOutput) => socket.send(JSON.stringify(output));
    let viewers = this.viewers.get(room.id);
    if (viewers === undefined) this.viewers.set(room.id, (viewers = new Set()));
    viewers.add(send);
    reply({ type: "project", project: await this.view(room.id) });
    let queue = Promise.resolve();
    return {
      receive: (data) => {
        queue = queue.then(async () => {
          let input: PanelInput;
          try {
            input = JSON.parse(data) as PanelInput;
          } catch {
            return reply({ type: "error", message: "Frames are JSON" });
          }
          const ref = typeof input.ref === "string" ? { ref: input.ref } : {};
          try {
            await this.act(room.id, input);
            reply({ type: "ok", ...ref });
            await this.changed(room.id);
          } catch (error) {
            reply({ type: "error", message: (error as Error).message, ...ref });
          }
        });
      },
      close: () => {
        viewers.delete(send);
        if (viewers.size === 0) this.viewers.delete(room.id);
      },
    };
  };
}

const PlanParameters = Type.Array(
  Type.Object({
    title: Type.String({ description: "What the milestone delivers." }),
    tasks: Type.Array(
      Type.Object({
        title: Type.String({ description: "One task an agent can finish in one pull request." }),
        criteria: Type.Optional(
          Type.Array(Type.String(), { description: "Acceptance criteria, each checkable." }),
        ),
      }),
    ),
  }),
  { description: "Milestones in order, each with its tasks." },
);

/** The extension with its options; the default export takes the defaults. */
export function projectsExtension(options: ProjectsOptions = {}) {
  return defineNudgeExtension({
    name: "projects",
    version: VERSION,
    apiVersion: "1.0",
    description:
      "Take a software project from idea to merged code: the assistant plans it with you, then supervises coding agents on an exe.dev VM, with gates for the plan, secrets and merges.",
    settings: Settings,
    setup: (host) => {
      const settings = host.settings;
      const report = options.report ?? ((error: unknown) => console.error("projects:", error));
      const random = options.random ?? (() => randomBytes(2).toString("hex"));
      const documents = (): ExtensionDocuments => host.documents();
      const acc = (): AccApi => {
        const found = accApi(host.assistant());
        if (found === undefined)
          throw new ProjectError("Projects need the acc extension, on and set up.");
        return found;
      };
      const scope = (roomId: string) => `project:${roomId}`;
      /** Every secret value the room's agents get, for scrubbing what they print. */
      const secretValues = (roomId: string): string[] => [
        ...host.secrets.names(scope(roomId)).map((name) => host.secrets.get(scope(roomId), name)!),
        ...host.secrets.names(ACCOUNT).map((name) => host.secrets.get(ACCOUNT, name)!),
      ];
      const scrub = (roomId: string, value: string) => scrubSecrets(value, secretValues(roomId));

      const snapshot = async (roomId: string): Promise<Project | undefined> => {
        const state = await documents().snapshot(ProjectDoc, roomId, context);
        return state?.project === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(state.project)) as Project);
      };
      /** Changes the room's project and tells its panels. */
      const change = async <T>(
        roomId: string,
        apply: (project: Project) => T | Promise<T>,
      ): Promise<T> => {
        const result = await documents().commit(async (tx) => {
          const project = await projectIn(tx, roomId);
          const out = await apply(project);
          project.updatedAt = host.now();
          return out;
        }, context);
        void panels.changed(roomId);
        return result;
      };

      const spend = async (roomId: string, project: Project): Promise<number> => {
        const state = await documents().snapshot(SpendDoc, context);
        const from = monthOf(project.startedAt, host.timeZone);
        return Object.entries(state?.months ?? {})
          .filter(([month]) => month >= from)
          .reduce((sum, [, month]) => sum + (month.rooms[roomId] ?? 0), 0);
      };

      const view = async (roomId: string): Promise<ProjectView | null> => {
        const project = await snapshot(roomId);
        if (project === undefined) return null;
        const api = accApi(host.assistant());
        const taskView = async (task: Task): Promise<TaskView> => {
          const { milestone: _, heardAt: _h, checkedAt: _c, session, ...rest } = task;
          const state =
            session === undefined
              ? undefined
              : await api?.state(session.host, session.id).catch(() => undefined);
          return {
            ...rest,
            ...(session === undefined
              ? {}
              : { session: { ...session, ...(state === undefined ? {} : { state }) } }),
          };
        };
        return {
          id: roomId,
          name: project.name,
          status: project.status,
          brief: project.brief,
          ...(project.repo === undefined ? {} : { repo: project.repo }),
          milestones: await Promise.all(
            project.milestones.map(async (milestone) => ({
              ...milestone,
              tasks: await Promise.all(tasksOf(project, milestone.id).map(taskView)),
            })),
          ),
          ...(project.vm === undefined
            ? {}
            : { vm: { name: project.vm.name, host: project.vm.host, ready: project.vm.ready } }),
          secrets: [...project.secrets],
          spendUsd: await spend(roomId, project),
          ...(project.budgetUsd === undefined ? {} : { budgetUsd: project.budgetUsd }),
          maxAgents: project.maxAgents,
          updatedAt: project.updatedAt,
        };
      };

      const pause = (roomId: string) =>
        change(roomId, (project) => {
          if (project.status !== "running") throw new ProjectError("The project isn't running.");
          project.status = "paused";
        });
      const resume = (roomId: string) =>
        change(roomId, (project) => {
          if (project.status !== "paused") throw new ProjectError("The project isn't paused.");
          project.status = "running";
          delete project.budgetWarned;
        });
      const panels = new Panels(view, async (roomId, input) => {
        if (input.type === "pause") await pause(roomId);
        else if (input.type === "resume") await resume(roomId);
        else throw new ProjectError("Unknown input");
        await wake(
          roomId,
          `panel:${input.type}:${host.now()}`,
          `Someone ${input.type === "pause" ? "paused" : "resumed"} the project from its panel. Tell the room briefly.`,
          `Project ${input.type === "pause" ? "paused" : "resumed"}`,
        );
      });

      /**
       * Wakes the room's supervisor with input it answers, at most `wakesPerHour` times an hour;
       * false when over. `key` makes a repeat after a restart find the first.
       */
      const wake = async (
        roomId: string,
        key: string,
        content: string,
        message: string,
        limited = false,
      ): Promise<boolean> => {
        const nudge = host.assistant();
        const project = await snapshot(roomId);
        if (limited && project !== undefined) {
          const hour = Math.floor(host.now() / 3_600_000) * 3_600_000;
          const [at, count] = project.wakes ?? [hour, 0];
          const used = at === hour ? count : 0;
          if (used >= settings.wakesPerHour) return false;
          await change(roomId, (stored) => {
            stored.wakes = [hour, used + 1];
          });
        }
        const room = await nudge.rooms.get(roomId, context);
        if (room === undefined) return false;
        const conversation = await nudge.harness.conversation(
          room.conversationId as ConversationId,
          context,
        );
        await conversation?.submit(
          {
            type: "input",
            content: nudge.redact(scrub(roomId, content)),
            whenBusy: "followUp",
            requestId: `projects:${roomId}:${key}`,
            entry: {
              kind: FIRE_ENTRY,
              data: {
                nudgeId: `project-${roomId}`,
                message: nudge.redact(scrub(roomId, message)),
                fireAt: host.now(),
                source: "watch",
                ...(project === undefined ? {} : { scheduledBy: project.owner }),
              } satisfies FireEntryData,
            },
          },
          context,
        );
        return true;
      };

      /** Runs a script on the project's VM; its output scrubbed. */
      const onVm = async (
        roomId: string,
        project: Project,
        script: string,
        stdin?: string,
      ): Promise<{ out: string; ok: boolean }> => {
        if (project.vm === undefined)
          throw new ProjectError("The project has no VM yet; ask for one with project_request_vm.");
        const result = await acc().exec(project.vm.name, script, stdin);
        return {
          out: scrub(roomId, `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`),
          ok: result.exitCode === 0,
        };
      };

      /** Writes the env file, and Codex's login when there is one, to the VM. */
      const writeSecrets = async (roomId: string, project: Project): Promise<string> => {
        const values: Record<string, string> = {};
        for (const name of host.secrets.names(ACCOUNT))
          values[name] = host.secrets.get(ACCOUNT, name)!;
        for (const name of host.secrets.names(scope(roomId)))
          values[name] = host.secrets.get(scope(roomId), name)!;
        const env = await onVm(roomId, project, WRITE_ENV, envFile(values));
        if (!env.ok) throw new ProjectError(`Writing the env file failed: ${cut(env.out, 500)}`);
        const codex = values.CODEX_AUTH_JSON;
        if (codex !== undefined) {
          const written = await onVm(roomId, project, WRITE_CODEX_AUTH, codex);
          if (!written.ok)
            throw new ProjectError(`Writing Codex's login failed: ${cut(written.out, 500)}`);
        }
        return `Wrote ${Object.keys(values).length} secrets to the VM.`;
      };

      /** Sets the VM up: secrets, agent CLIs, the repo. Tries the connection a few times. */
      const bootstrap = async (roomId: string): Promise<string> => {
        const project = await snapshot(roomId);
        if (project === undefined) throw new ProjectError("There is no project in this room.");
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const secrets = await writeSecrets(roomId, project);
            const { out, ok } = await onVm(roomId, project, bootstrapScript(project.repo));
            await change(roomId, (stored) => {
              if (stored.vm !== undefined) stored.vm.ready = ok;
            });
            return `${secrets}\n${cut(out, MAX_OUTPUT)}${ok ? "\nThe VM is ready." : "\nThe VM isn't ready."}`;
          } catch (error) {
            lastError = error;
            if (error instanceof ProjectError) throw error;
            await new Promise((resolve) => setTimeout(resolve, options.tickMs ?? 10_000));
          }
        }
        throw new ProjectError(
          `Couldn't reach the VM: ${scrub(roomId, (lastError as Error)?.message ?? String(lastError))}`,
        );
      };

      /** Starts an agent on a task, building it or, with `review`, reviewing its PR. */
      const startTask = async (
        roomId: string,
        taskId: string,
        how: { review?: boolean; harness?: "claude" | "codex"; model?: string } = {},
      ): Promise<string> => {
        const project = await snapshot(roomId);
        if (project === undefined) throw new ProjectError("There is no project in this room.");
        if (project.status !== "running")
          throw new ProjectError(`The project is ${project.status}; agents start while it runs.`);
        if (project.vm?.ready !== true)
          throw new ProjectError("The VM isn't set up yet; run project_bootstrap.");
        const task = findTask(project, taskId);
        if (how.review === true ? task.status !== "review" : task.status !== "todo")
          throw new ProjectError(`${task.id} is ${task.status}.`);
        if (running(project).length >= project.maxAgents)
          throw new ProjectError(
            `${project.maxAgents} agents work already; wait for one to finish or raise max_agents.`,
          );
        const tree = await onVm(roomId, project, worktreeScript(task.id));
        if (!tree.ok) throw new ProjectError(`Making the worktree failed: ${cut(tree.out, 800)}`);
        const cwd = tree.out.trim().split("\n").at(-1)!;
        const harness =
          how.harness ?? (how.review === true ? settings.reviewHarness : settings.harness);
        const started = await acc().start(roomId, {
          host: project.vm.name,
          harness,
          cwd,
          prompt: how.review === true ? reviewPrompt(project, task) : taskPrompt(project, task),
          ...(how.model === undefined ? {} : { model: how.model }),
        });
        await change(roomId, (stored) => {
          const t = findTask(stored, task.id);
          if (how.review !== true) t.status = "running";
          t.branch = `task/${task.id}`;
          t.session = { host: stored.vm!.name, id: started.id };
          t.heardAt = host.now();
        });
        return `${how.review === true ? "A review" : "An agent"} (${harness}) works on ${task.id} "${task.title}" as session ${project.vm.name}/${started.id}, on branch task/${task.id}.`;
      };

      /** Checks the PRs' CI with gh on the VM, and keeps what it found. */
      const checkPrs = async (roomId: string, project: Project): Promise<string> => {
        const withPr = project.tasks.filter((task) => task.pr !== undefined);
        if (withPr.length === 0 || project.vm?.ready !== true) return "";
        const { out } = await onVm(roomId, project, prsScript(withPr.map((t) => t.pr!.url)));
        const found = out
          .split("\n")
          .map((line) => {
            try {
              return JSON.parse(line) as {
                url: string;
                number?: number;
                state?: string;
                checks?: string[];
                error?: true;
              };
            } catch {
              return undefined;
            }
          })
          .filter((line) => line !== undefined);
        await change(roomId, (stored) => {
          for (const pr of found) {
            const task = stored.tasks.find((t) => t.pr?.url === pr.url);
            if (task === undefined || pr.error) continue;
            task.pr = {
              url: pr.url,
              ...(pr.number === undefined ? {} : { number: pr.number }),
              ci: ciOf(pr.checks ?? []),
            };
            if (pr.state === "MERGED") task.status = "done";
          }
        });
        return found
          .map((pr) =>
            pr.error
              ? `${pr.url}: couldn't read it`
              : `${pr.url}: ${pr.state?.toLowerCase()}, CI ${ciOf(pr.checks ?? [])}`,
          )
          .join("\n");
      };

      /** In tools: the room the call is in, and its project. */
      const here = async (api: ToolExecutionApi, ctx: Context) => {
        const room = await roomOf(api, api.conversationId, ctx);
        return { room, project: await snapshot(room.id) };
      };
      const guarded =
        <A>(
          run: (
            args: A,
            roomId: string,
            project: Project | undefined,
          ) => Promise<string | { text: string; ui: UiCard | undefined }>,
        ) =>
        async (args: A, api: ToolExecutionApi, ctx: Context) => {
          const { room, project } = await here(api, ctx);
          try {
            const done = await run(args, room.id, project);
            if (typeof done === "string") return text(done);
            return {
              ...text(done.text),
              ...(done.ui === undefined ? {} : { details: { ui: done.ui } }),
            };
          } catch (error) {
            return text(scrub(room.id, (error as Error).message), true);
          }
        };
      const need = (project: Project | undefined): Project => {
        if (project === undefined)
          throw new ProjectError(
            "There is no project in this room. Start one with project_create.",
          );
        return project;
      };

      /** Asks the room to approve, inside a tool; returns the tool's result. */
      const ask = async (
        api: ToolExecutionApi,
        ctx: Context,
        roomId: string,
        draft: Omit<ApprovalDraft, "extension">,
        waiting: string,
      ) => {
        const approval = await api.commit(
          (tx) => requestApproval(tx, roomId, { extension: "projects", ...draft }, host.now()),
          ctx,
        );
        return { ...text(`${waiting} (${approval.id}).`), details: { approval: approval.id } };
      };

      const createTool = defineTool({
        name: "project_create",
        description:
          "Start a software project: makes a room for it with the same people as this one, where you interview " +
          "them briefly, plan it, and then supervise coding agents that build it.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 60, description: "The project's name." }),
        }),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          const nudge = host.assistant();
          const owner = actingFor(currentTurn());
          if (owner === undefined)
            return text("Only a person can start a project, not a wake-up.", true);
          try {
            acc();
            const members = (await nudge.rooms.members(room.id, ctx)).map((player) => player.id);
            const made = await nudge.rooms.createShared(
              { name: args.name.trim(), members: members.length > 0 ? members : [owner.playerId] },
              ctx,
            );
            for (const extension of ["projects", "acc"])
              await nudge.setRoomExtension(made.id, extension, true, ctx).catch(() => undefined);
            await documents().commit(async (tx) => {
              const state = await tx.doc(ProjectDoc, made.id, null);
              state.project = newProject(args.name.trim(), owner, settings.maxAgents, host.now());
            }, ctx);
            await wake(
              made.id,
              "created",
              `${owner.displayName} started the project "${args.name.trim()}" here. Greet them and interview them ` +
                "briefly, one question at a time: the goal and what done means, the stack, the repo (new or " +
                "existing on GitHub), where it deploys, and limits such as a budget or a deadline. Then write the " +
                "brief and plan with project_plan, and ask to start with project_start.",
              `Project "${args.name.trim()}" started`,
            );
            return text(
              `Made the room "${made.name}" (${made.id}) for the project; the interview goes on there. Tell them to open it.`,
            );
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      const planTool = defineTool({
        name: "project_plan",
        description:
          "Write or change this room's project: its brief, repo, budget, and the plan of milestones and their " +
          "tasks with acceptance criteria. Tasks agents worked on stay.",
        parameters: Type.Object({
          brief: Type.Optional(
            Type.String({
              description:
                "Goal and what done means, the stack, where it deploys, limits: what the interview found.",
            }),
          ),
          repo: Type.Optional(Type.String({ description: "The GitHub repo, owner/name." })),
          budget_usd: Type.Optional(
            Type.Number({ minimum: 0, description: "What the assistant may spend on it." }),
          ),
          max_agents: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
          milestones: Type.Optional(PlanParameters),
        }),
        execute: guarded(
          async (
            args: {
              brief?: string;
              repo?: string;
              budget_usd?: number;
              max_agents?: number;
              milestones?: PlanDraft;
            },
            roomId,
            project,
          ) => {
            need(project);
            if (
              args.repo !== undefined &&
              !/^[\w.-]+\/[\w.-]+$|^(https:\/\/|git@)\S+$/.test(args.repo.trim())
            )
              throw new ProjectError("The repo is owner/name, or a git URL.");
            await change(roomId, (stored) => {
              if (args.brief !== undefined) stored.brief = args.brief.trim();
              if (args.repo !== undefined) stored.repo = args.repo.trim();
              if (args.budget_usd !== undefined) {
                stored.budgetUsd = args.budget_usd;
                delete stored.budgetWarned;
              }
              if (args.max_agents !== undefined) stored.maxAgents = Math.round(args.max_agents);
              if (args.milestones !== undefined) setPlan(stored, args.milestones);
            });
            const now = need(await snapshot(roomId));
            return `The plan now:\n${describePlan(now) || "(no milestones yet)"}${
              now.status === "planning"
                ? "\nAsk to start it with project_start once people agree."
                : ""
            }`;
          },
        ),
      });

      const startTool = defineTool({
        name: "project_start",
        description:
          "Ask the room to approve the plan and start the project. The only stop before work begins.",
        parameters: Type.Object({}),
        execute: async (_args, api, ctx) => {
          const { room, project } = await here(api, ctx);
          if (project === undefined) return text("There is no project in this room.", true);
          if (project.status !== "planning")
            return text(`The project is ${project.status} already.`, true);
          if (project.milestones.length === 0 || project.brief === "")
            return text("Write the brief and the plan with project_plan first.", true);
          return ask(
            api,
            ctx,
            room.id,
            {
              kind: "plan",
              summary: `Start project "${project.name}": ${project.milestones.length} milestones, ${project.tasks.length} tasks${
                project.budgetUsd === undefined ? "" : `, budget $${project.budgetUsd}`
              }.\n${cut(describePlan(project), 1_200)}`,
              payload: {},
            },
            "Waiting for someone to approve the plan",
          );
        },
      });

      const requestVmTool = defineTool({
        name: "project_request_vm",
        description:
          "Ask for the project's exe.dev VM. Someone launches it from the Nudge app on their phone, which " +
          "holds the exe.dev login; the agents then run there.",
        parameters: Type.Object({}),
        execute: async (_args, api, ctx) => {
          const { room, project } = await here(api, ctx);
          if (project === undefined) return text("There is no project in this room.", true);
          if (project.vm !== undefined)
            return text(`The project has the VM ${project.vm.name} already.`, true);
          let key: string;
          try {
            key = acc().publicKey();
          } catch (error) {
            return text((error as Error).message, true);
          }
          const name = vmName(project.name, random());
          return ask(
            api,
            ctx,
            room.id,
            {
              kind: "vm",
              summary: `Launch the exe.dev VM "${name}" for "${project.name}". The assistant's agents log in to it with its own key.`,
              payload: { name },
              inputs: [
                { name: "vm", label: "VM", secret: false },
                { name: "sshHost", label: "SSH host", secret: false },
                { name: "sshUser", label: "SSH user", secret: false, optional: true },
                { name: "sshKeyError", label: "Key problem", secret: false, optional: true },
              ],
              clientAction: {
                type: "exe.new",
                name,
                ...(settings.vmImage === undefined ? {} : { image: settings.vmImage }),
                sshKey: key,
              },
            },
            "Waiting for someone to launch the VM from the Nudge app",
          );
        },
      });

      const bootstrapTool = defineTool({
        name: "project_bootstrap",
        description:
          "Set the project's VM up, or again after a change: writes the secrets, installs the agent CLIs and gh " +
          "where missing, and clones the repo. Says what is still missing.",
        parameters: Type.Object({}),
        execute: guarded(async (_args, roomId, project) => {
          need(project);
          return bootstrap(roomId);
        }),
      });

      const secretTool = defineTool({
        name: "project_request_secret",
        description:
          "Ask for a secret the project needs, such as STRIPE_KEY, through a card with a password field. The " +
          "value goes to the agents on the VM as an environment variable and never to you; you only hear that " +
          `it is set. With account, it is the person's own login for every project: ${Object.entries(
            ACCOUNT_SECRETS,
          )
            .map(([name, what]) => `${name} (${what})`)
            .join("; ")}. Never ask for secrets in chat.`,
        parameters: Type.Object({
          name: Type.String({ description: "As an environment variable: A-Z, 0-9 and _." }),
          why: Type.String({ description: "What it is for, and where to get it." }),
          account: Type.Optional(Type.Boolean({ description: "One of the person's own logins." })),
        }),
        execute: async (args, api, ctx) => {
          const { room, project } = await here(api, ctx);
          if (project === undefined) return text("There is no project in this room.", true);
          const name = args.name.trim().toUpperCase();
          if (!SECRET_NAME.test(name))
            return text("Secret names are A-Z, 0-9 and _, such as STRIPE_KEY.", true);
          const account = args.account === true || name in ACCOUNT_SECRETS;
          return ask(
            api,
            ctx,
            room.id,
            {
              kind: "secret",
              summary: `Give ${account ? "your" : `"${project.name}"'s`} ${name}: ${args.why.trim()}`,
              payload: { name, account },
              inputs: [{ name: "value", label: name, secret: true, description: args.why.trim() }],
              ...(account ? { adminOnly: true } : {}),
            },
            `Waiting for someone to give ${name}`,
          );
        },
      });

      const statusTool = defineTool({
        name: "project_status",
        description:
          "This room's project: its plan with each task's state, agent and PR, the VM, the secrets set, and spend. " +
          "With check_prs, also each PR's state and CI from GitHub.",
        parameters: Type.Object({ check_prs: Type.Optional(Type.Boolean()) }),
        replay: "safe",
        execute: guarded(async (args: { check_prs?: boolean }, roomId, project) => {
          const found = need(project);
          const prs = args.check_prs === true ? await checkPrs(roomId, found) : "";
          const now = need(await snapshot(roomId));
          const api = accApi(host.assistant());
          const states = new Map<string, string>();
          const agents = await Promise.all(
            running(now).map(async (task) => {
              const state = await api
                ?.state(task.session!.host, task.session!.id)
                .catch(() => undefined);
              if (state !== undefined) states.set(task.id, state);
              return `${task.id}: ${task.session!.host}/${task.session!.id}, ${state ?? "not read yet"}`;
            }),
          );
          const spent = await spend(roomId, now);
          const card = projectCard(now, spent, states);
          const lines = [
            `"${now.name}" is ${now.status}.${now.repo === undefined ? "" : ` Repo ${now.repo}.`}`,
            describePlan(now) || "(no plan yet)",
            agents.length === 0 ? "No agents work now." : `Agents:\n${agents.join("\n")}`,
            now.vm === undefined
              ? "No VM yet."
              : `VM ${now.vm.name} (${now.vm.user}@${now.vm.host}), ${now.vm.ready ? "set up" : "not set up"}.`,
            `Secrets set: ${now.secrets.join(", ") || "none"}. Your logins set: ${host.secrets.names(ACCOUNT).join(", ") || "none"}.`,
            `Spent $${spent.toFixed(2)}${now.budgetUsd === undefined ? "" : ` of $${now.budgetUsd}`}.`,
            ...(prs === "" ? [] : [`PRs:\n${prs}`]),
          ].join("\n");
          return { text: lines, ui: card };
        }),
      });

      const taskStartTool = defineTool({
        name: "project_task_start",
        description:
          "Start an agent on a task of the active milestone, in its own worktree on branch task/<id>. With review, " +
          "start a reviewing agent on a task in review instead. Ready tasks also start on their own.",
        parameters: Type.Object({
          id: Type.String({ description: "The task, such as t3." }),
          review: Type.Optional(Type.Boolean()),
          harness: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
          model: Type.Optional(Type.String()),
        }),
        execute: guarded(
          async (
            args: { id: string; review?: boolean; harness?: "claude" | "codex"; model?: string },
            roomId,
            project,
          ) => {
            need(project);
            return startTask(roomId, args.id, {
              ...(args.review === undefined ? {} : { review: args.review }),
              ...(args.harness === undefined ? {} : { harness: args.harness }),
              ...(args.model === undefined ? {} : { model: args.model }),
            });
          },
        ),
      });

      const taskUpdateTool = defineTool({
        name: "project_task_update",
        description:
          "Change a task: its status (such as review once its agent opened a PR, blocked, skipped), PR, CI or note. " +
          "Without an id, adds a task to a milestone. With stop_agent, its agent exits.",
        parameters: Type.Object({
          id: Type.Optional(Type.String()),
          milestone: Type.Optional(
            Type.String({ description: "For a new task; default the active one." }),
          ),
          title: Type.Optional(Type.String()),
          criteria: Type.Optional(Type.Array(Type.String())),
          status: Type.Optional(
            Type.Union(
              (["todo", "running", "review", "done", "blocked", "skipped"] as const).map((s) =>
                Type.Literal(s),
              ),
            ),
          ),
          pr_url: Type.Optional(Type.String()),
          ci: Type.Optional(
            Type.Union([Type.Literal("pending"), Type.Literal("passing"), Type.Literal("failing")]),
          ),
          note: Type.Optional(Type.String()),
          stop_agent: Type.Optional(Type.Boolean()),
        }),
        execute: guarded(
          async (
            args: {
              id?: string;
              milestone?: string;
              title?: string;
              criteria?: string[];
              status?: Task["status"];
              pr_url?: string;
              ci?: "pending" | "passing" | "failing";
              note?: string;
              stop_agent?: boolean;
            },
            roomId,
            project,
          ) => {
            need(project);
            if (args.pr_url !== undefined && !/^https:\/\/\S+$/.test(args.pr_url.trim()))
              throw new ProjectError("pr_url is the PR's https address.");
            let stop: Task["session"];
            const id = await change(roomId, (stored) => {
              if (args.id === undefined) {
                if (args.title === undefined) throw new ProjectError("A new task needs a title.");
                const milestone =
                  args.milestone === undefined
                    ? (activeMilestone(stored) ??
                      stored.milestones.find((m) => m.status === "planned"))
                    : stored.milestones.find((m) => m.id === args.milestone);
                if (milestone === undefined || milestone.status === "merged")
                  throw new ProjectError("Say which milestone, one not merged yet.");
                const task: Task = {
                  id: `t${Math.max(0, ...stored.tasks.map((t) => Number(t.id.slice(1)) || 0)) + 1}`,
                  milestone: milestone.id,
                  title: args.title.trim(),
                  criteria: (args.criteria ?? []).map((line) => line.trim()).filter(Boolean),
                  status: "todo",
                };
                stored.tasks.push(task);
                if (milestone.status === "gate") milestone.status = "active";
                return task.id;
              }
              const task = findTask(stored, args.id);
              if (args.title !== undefined) task.title = args.title.trim();
              if (args.criteria !== undefined)
                task.criteria = args.criteria.map((l) => l.trim()).filter(Boolean);
              if (args.status !== undefined) task.status = args.status;
              if (args.pr_url !== undefined)
                task.pr = {
                  url: args.pr_url.trim(),
                  ...(/\/pull\/(\d+)/.exec(args.pr_url)?.[1] === undefined
                    ? {}
                    : { number: Number(/\/pull\/(\d+)/.exec(args.pr_url)![1]) }),
                  ...(task.pr?.ci === undefined ? {} : { ci: task.pr.ci }),
                };
              if (args.ci !== undefined && task.pr !== undefined) task.pr.ci = args.ci;
              if (args.note !== undefined) task.note = args.note.trim();
              if (args.stop_agent === true && task.session !== undefined) {
                stop = task.session;
                delete task.session;
              }
              return task.id;
            });
            if (stop !== undefined) await acc().stop(stop.host, stop.id).catch(report);
            const now = need(await snapshot(roomId));
            const task = findTask(now, id);
            const milestone = activeMilestone(now);
            return (
              `${task.id} "${task.title}" is ${task.status}${task.pr === undefined ? "" : `, PR ${task.pr.url}`}.` +
              (milestone !== undefined && milestoneReady(now, milestone.id)
                ? ` Every task of ${milestone.id} is finished: check CI with project_status check_prs, then project_gate.`
                : "")
            );
          },
        ),
      });

      const gateTool = defineTool({
        name: "project_gate",
        description:
          "Ask the room to approve merging the active milestone's PRs, in order. Call it once every task of the " +
          "milestone is in review or done with CI passing.",
        parameters: Type.Object({
          force: Type.Optional(
            Type.Boolean({ description: "Ask even though some tasks aren't finished." }),
          ),
        }),
        execute: async (args, api, ctx) => {
          const { room, project } = await here(api, ctx);
          if (project === undefined) return text("There is no project in this room.", true);
          const milestone = activeMilestone(project);
          if (milestone === undefined || project.status !== "running")
            return text(`Nothing to merge: the project is ${project.status}.`, true);
          if (!milestoneReady(project, milestone.id) && args.force !== true)
            return text(
              `${milestone.id} still has tasks open: ${tasksOf(project, milestone.id)
                .filter((t) => !["review", "done", "skipped"].includes(t.status))
                .map((t) => `${t.id} (${t.status})`)
                .join(", ")}.`,
              true,
            );
          const prs = tasksOf(project, milestone.id).filter(
            (t) => t.pr !== undefined && t.status !== "done" && t.status !== "skipped",
          );
          await change(room.id, (stored) => {
            stored.status = "gate";
            stored.milestones.find((m) => m.id === milestone.id)!.status = "gate";
          });
          return ask(
            api,
            ctx,
            room.id,
            {
              kind: "gate",
              summary:
                `Milestone ${milestone.id} "${milestone.title}" is ready: merge ${prs.length} PRs in order?\n` +
                prs
                  .map(
                    (t) =>
                      `${t.id} ${t.title}: ${t.pr!.url}${t.pr!.ci ? ` (CI ${t.pr!.ci})` : ""}${t.note ? ` — ${t.note}` : ""}`,
                  )
                  .join("\n"),
              payload: { milestone: milestone.id },
            },
            "Waiting for someone to approve the merge",
          );
        },
      });

      const pauseTool = defineTool({
        name: "project_pause",
        description:
          "Pause the project: no new agents start and nothing wakes you for it. Agents working finish their turn; stop them with project_task_update stop_agent.",
        parameters: Type.Object({}),
        execute: guarded(async (_args, roomId, project) => {
          need(project);
          await pause(roomId);
          return "Paused.";
        }),
      });

      const resumeTool = defineTool({
        name: "project_resume",
        description: "Resume a paused project.",
        parameters: Type.Object({}),
        execute: guarded(async (_args, roomId, project) => {
          need(project);
          await resume(roomId);
          return "Running again.";
        }),
      });

      const finishTool = defineTool({
        name: "project_finish",
        description:
          "End the project after the final report: agents stop, and with delete_vm someone deletes the VM from the " +
          "Nudge app; without it the VM is kept.",
        parameters: Type.Object({ delete_vm: Type.Boolean() }),
        execute: async (args, api, ctx) => {
          const { room, project } = await here(api, ctx);
          if (project === undefined) return text("There is no project in this room.", true);
          const stops = running(project).map((task) => task.session!);
          await change(room.id, (stored) => {
            stored.status = "done";
            for (const task of stored.tasks) delete task.session;
          });
          for (const session of stops)
            await accApi(host.assistant())?.stop(session.host, session.id).catch(report);
          if (!args.delete_vm || project.vm === undefined)
            return text(
              `"${project.name}" is done.${project.vm === undefined ? "" : ` The VM ${project.vm.name} is kept.`}`,
            );
          return ask(
            api,
            ctx,
            room.id,
            {
              kind: "vmDelete",
              summary: `Delete the VM "${project.vm.name}" of "${project.name}" and everything on it.`,
              payload: { name: project.vm.name },
              clientAction: { type: "exe.rm", name: project.vm.name },
            },
            `"${project.name}" is done. Waiting for someone to delete the VM from the Nudge app`,
          );
        },
      });

      /** The rooms with a project, and their projects. */
      const projects = async (): Promise<[string, Project][]> => {
        const nudge = host.assistant();
        const all: [string, Project][] = [];
        for (const room of await nudge.rooms.list(context)) {
          const project = await snapshot(room.id);
          if (project !== undefined) all.push([room.id, project]);
        }
        return all;
      };

      /** What wakes need checking now: budget, stalls, ready tasks, gates, digests. */
      const tick = async (): Promise<void> => {
        for (const [roomId, project] of await projects()) {
          if (project.status !== "running") continue;
          const now = host.now();
          // Budget.
          if (project.budgetUsd !== undefined && !project.budgetWarned) {
            const spent = await spend(roomId, project);
            if (spent >= project.budgetUsd * settings.budgetWarnAt) {
              await change(roomId, (stored) => {
                stored.status = "paused";
                stored.budgetWarned = true;
              });
              await wake(
                roomId,
                `budget:${project.budgetUsd}`,
                `The project has spent $${spent.toFixed(2)} of its $${project.budgetUsd} budget, so it is paused. ` +
                  "Ask whether to go on (project_resume) or raise the budget (project_plan budget_usd).",
                "Project paused: budget",
              );
              continue;
            }
          }
          // Ready tasks start on their own, up to the agents allowed.
          if (project.vm?.ready === true) {
            const free = project.maxAgents - running(project).length;
            for (const task of ready(project).slice(0, Math.max(0, free))) {
              try {
                const started = await startTask(roomId, task.id);
                await wake(
                  roomId,
                  `started:${task.id}`,
                  `${started} Tell the room in one line.`,
                  `Started ${task.id}`,
                  true,
                );
              } catch (error) {
                await change(roomId, (stored) => {
                  const t = findTask(stored, task.id);
                  t.status = "blocked";
                  t.note = scrub(roomId, (error as Error).message);
                });
                await wake(
                  roomId,
                  `blocked:${task.id}:${now}`,
                  `Starting an agent on ${task.id} failed: ${(error as Error).message}\nSort it out or tell the room.`,
                  `${task.id} didn't start`,
                  true,
                );
              }
            }
          }
          // Quiet agents.
          const quiet = settings.stallMinutes * 60_000;
          for (const task of running(project)) {
            if (now - (task.heardAt ?? 0) < quiet || now - (task.checkedAt ?? 0) < quiet) continue;
            await change(roomId, (stored) => {
              findTask(stored, task.id).checkedAt = now;
            });
            await wake(
              roomId,
              `quiet:${task.id}:${now}`,
              `The agent on ${task.id} (${task.session!.host}/${task.session!.id}) has been quiet for ${settings.stallMinutes} minutes. ` +
                "Check it with acc_read: nudge it with acc_send if it's stuck, or leave it if it's working. Only tell the room if something is wrong.",
              `Checking on ${task.id}`,
              true,
            );
          }
          // A milestone ready for its gate.
          const milestone = activeMilestone(project);
          if (milestone?.status === "active" && milestoneReady(project, milestone.id))
            await wake(
              roomId,
              `ready:${milestone.id}`,
              `Every task of ${milestone.id} "${milestone.title}" is finished. Check CI with project_status check_prs, ` +
                "fix what fails, then ask to merge with project_gate.",
              `${milestone.id} ready`,
              true,
            );
          // The digest.
          if (project.digestAt === undefined || now >= project.digestAt) {
            const first = project.digestAt === undefined;
            await change(roomId, (stored) => {
              stored.digestAt = nextHour(now, settings.digestHour, host.timeZone);
            });
            if (!first)
              await wake(
                roomId,
                `digest:${project.digestAt}`,
                "Time for the project's daily digest: in a few lines, what got done since the last one, what is in progress, what is blocked, and anything people must do.",
                "Project digest",
              );
          }
        }
      };

      const heard = (follow: { roomId: string; host: string; id: string }, key: string) => {
        void (async () => {
          const project = await snapshot(follow.roomId);
          const task = project?.tasks.find(
            (t) => t.session?.host === follow.host && t.session.id === follow.id,
          );
          if (task === undefined) return;
          await change(follow.roomId, (stored) => {
            const t = findTask(stored, task.id);
            t.heardAt = host.now();
            if (key === "exited") delete t.session;
          });
        })().catch(report);
      };

      let unhook: (() => void)[] = [];
      let timer: ReturnType<typeof setInterval> | undefined;
      let ticking = false;
      let closed = false;
      void host.whenOpen().then((assistant: ExtensionAssistant) => {
        if (closed) return;
        const api = accApi(assistant);
        if (api !== undefined) unhook = [api.addScrubber(scrub), api.onHeard(heard)];
        timer = setInterval(() => {
          if (ticking) return;
          ticking = true;
          tick()
            .catch(report)
            .finally(() => (ticking = false));
        }, options.tickMs ?? 60_000);
        timer.unref?.();
      });

      return {
        problems: () => {
          try {
            host.assistant();
          } catch {
            return [];
          }
          return accApi(host.assistant()) === undefined
            ? ["Projects need the acc extension, installed and with its binding."]
            : [];
        },
        tools: [
          createTool,
          planTool,
          startTool,
          requestVmTool,
          bootstrapTool,
          secretTool,
          readsOnly(statusTool, (args) => args.check_prs !== true),
          taskStartTool,
          taskUpdateTool,
          gateTool,
          pauseTool,
          resumeTool,
          finishTool,
        ],
        sections: [
          section("projects", async (input, ctx) => {
            const room = await roomOf(input.read, input.conversationId, ctx).catch(() => undefined);
            if (room === undefined) return undefined;
            const project = await snapshot(room.id);
            if (project === undefined)
              return "To take a software project from idea to merged code with coding agents, start it with project_create.";
            return projectSection(
              project,
              await spend(room.id, project),
              host.secrets.names(ACCOUNT),
            );
          }),
        ],
        roomSocket: panels.roomSocket,
        approvals: {
          plan: async (_payload, run) => {
            await change(run.room.id, (project) => {
              if (project.status !== "planning")
                throw new ProjectError(`The project is ${project.status} already.`);
              project.status = "running";
              project.startedAt = host.now();
              activateNext(project);
            });
            const project = (await snapshot(run.room.id))!;
            const missing = Object.keys(ACCOUNT_SECRETS).filter(
              (name) => !host.secrets.names(ACCOUNT).includes(name) && name !== "CODEX_AUTH_JSON",
            );
            return {
              text:
                `"${project.name}" runs.` +
                (project.vm === undefined ? " Next: ask for the VM with project_request_vm." : "") +
                (missing.length === 0
                  ? ""
                  : ` Logins still missing: ${missing.join(", ")} (project_request_secret).`),
            };
          },
          vm: async (payload, run) => {
            const vm = run.inputs.vm!.trim();
            const sshHost = run.inputs.sshHost!.trim();
            const user = run.inputs.sshUser?.trim() || settings.vmUser;
            if (
              !/^[a-z0-9][a-z0-9-]*$/.test(vm) ||
              !/^[A-Za-z0-9.-]+$/.test(sshHost) ||
              !/^[a-z_][a-z0-9_-]*$/.test(user)
            )
              return {
                text: "The app sent a VM name, host or user that doesn't look right.",
                isError: true,
              };
            await acc().addHost({ name: vm, host: sshHost, user, rooms: [run.room.id] });
            await change(run.room.id, (project) => {
              project.vm = { name: vm, host: sshHost, user, ready: false };
            });
            const keyProblem = run.inputs.sshKeyError;
            // Setting it up takes minutes; the person approving shouldn't wait for it.
            void bootstrap(run.room.id).then(
              (said) =>
                wake(
                  run.room.id,
                  `bootstrap:${vm}`,
                  `Setting up the VM ${vm} finished:\n${said}\nTell the room briefly what is missing, if anything.`,
                  "VM set up",
                ),
              (error) =>
                wake(
                  run.room.id,
                  `bootstrap:${vm}`,
                  `Setting up the VM ${vm} failed: ${(error as Error).message}\nTell the room; try again with project_bootstrap.`,
                  "VM setup failed",
                ),
            );
            void payload;
            return {
              text:
                `The VM ${vm} (${user}@${sshHost}) is the project's machine; it is being set up now.` +
                (keyProblem === undefined
                  ? ""
                  : ` The app couldn't add the assistant's key to exe.dev (${keyProblem}); if setting up fails, add this key there: ${acc().publicKey()}`),
            };
          },
          secret: async (payload, run) => {
            const { name, account } = payload as { name: string; account: boolean };
            const value = run.inputs.value!;
            host.secrets.set(account ? ACCOUNT : scope(run.room.id), name, value);
            await host.protect(value, "SECRET").catch(report);
            if (!account)
              await change(run.room.id, (project) => {
                if (!project.secrets.includes(name)) project.secrets.push(name);
              });
            const project = await snapshot(run.room.id);
            let written = "";
            if (project?.vm?.ready === true)
              written = await writeSecrets(run.room.id, project)
                .then(() => " and written to the VM")
                .catch((error: Error) => `, but writing it to the VM failed: ${error.message}`);
            return { text: `${name} is set${written}.` };
          },
          gate: async (payload, run) => {
            const { milestone: id } = payload as { milestone: string };
            const project = await snapshot(run.room.id);
            if (project === undefined) return { text: "The project is gone.", isError: true };
            const prs = tasksOf(project, id).filter(
              (t) => t.pr !== undefined && t.status !== "done" && t.status !== "skipped",
            );
            const { out, ok } = await onVm(
              run.room.id,
              project,
              mergeScript(prs.map((t) => t.pr!.url)),
            );
            const merged = new Set(
              out
                .split("\n")
                .filter((l) => l.startsWith("merged: "))
                .map((l) => l.slice(8).trim()),
            );
            let finished = false;
            await change(run.room.id, (stored) => {
              for (const task of tasksOf(stored, id))
                if (task.pr !== undefined && merged.has(task.pr.url)) {
                  task.status = "done";
                  delete task.session;
                }
              const milestone = stored.milestones.find((m) => m.id === id)!;
              if (ok) {
                milestone.status = "merged";
                finished = !activateNext(stored);
                stored.status = finished ? "done" : "running";
              } else {
                milestone.status = "active";
                stored.status = "running";
              }
            });
            if (!ok)
              return {
                text: `Merged ${merged.size} of ${prs.length}, then one failed:\n${cut(out, 1_500)}\nFix it (rebase the branch with acc_send to its agent), then project_gate again.`,
                isError: true,
              };
            return {
              text:
                `Merged ${merged.size} PRs of ${id}.` +
                (finished
                  ? " That was the last milestone: write the final report (what was built, links, open issues, what people must do), then project_finish."
                  : " The next milestone's tasks start now."),
            };
          },
          vmDelete: async (payload, run) => {
            const { name } = payload as { name: string };
            await acc().removeHost(name).catch(report);
            await change(run.room.id, (project) => {
              delete project.vm;
            });
            return { text: `The VM ${name} is deleted.` };
          },
        },
        denials: {
          plan: async () => {},
          gate: async (payload, run) => {
            const { milestone: id } = payload as { milestone: string };
            await change(run.room.id, (project) => {
              const milestone = project.milestones.find((m) => m.id === id);
              if (milestone !== undefined && milestone.status === "gate")
                milestone.status = "active";
              if (project.status === "gate") project.status = "running";
            });
          },
        },
        close: () => {
          closed = true;
          if (timer !== undefined) clearInterval(timer);
          for (const off of unhook) off();
        },
      };
    },
  });
}

/** What the model knows of a room's project, every turn: it keeps it on track after compaction. */
export function projectSection(project: Project, spent: number, logins: readonly string[]): string {
  const lines = [
    `This room is the software project "${project.name}", ${project.status}. You supervise the coding agents that build it; the people here steer you.`,
    project.brief === "" ? "No brief yet." : `Brief:\n${cut(project.brief, 2_500)}`,
    project.repo === undefined ? "No repo yet." : `Repo: ${project.repo}.`,
    project.milestones.length === 0 ? "No plan yet." : `Plan:\n${describePlan(project)}`,
    project.vm === undefined
      ? "No VM yet."
      : `VM: ${project.vm.name} (${project.vm.user}@${project.vm.host}), ${project.vm.ready ? "set up" : "not set up"}.`,
    `Secrets set: ${project.secrets.join(", ") || "none"}. The person's logins set: ${logins.join(", ") || "none"}.`,
    `Spent $${spent.toFixed(2)}${project.budgetUsd === undefined ? "" : ` of a $${project.budgetUsd} budget`}; up to ${project.maxAgents} agents at once.`,
    "How you work:",
    "- Planning: interview briefly, one question at a time. Then project_plan with the brief and milestones of small tasks (one PR each) with checkable acceptance criteria, and project_start to ask for approval.",
    "- Running: without a VM, project_request_vm. Ask for missing logins with project_request_secret: CLAUDE_CODE_OAUTH_TOKEN for Claude Code, CODEX_AUTH_JSON for Codex, GH_TOKEN for GitHub. Ready tasks start on their own once the VM is set up.",
    "- When an agent ends a turn: if it says DONE <url>, project_task_update status review with pr_url, then project_task_start review. If it asks something routine, answer with acc_send; bring people only decisions that are theirs. BLOCKED: project_task_update blocked, and tell the room why.",
    "- People's changes: update the plan with project_plan or project_task_update, and pass them to working agents with acc_send.",
    "- When a milestone's tasks are all in review or done and CI passes, project_gate. Never merge otherwise.",
    "- Secrets only through project_request_secret, never in chat. Never repeat one.",
    "- Posts here are short: a task done, a PR opened, a blocker. Stop for people only at the plan, merges, secrets, the budget and blockers.",
  ];
  return lines.join("\n");
}

export default projectsExtension();
