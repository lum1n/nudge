import { defineDocFamily, type SessionDocFamilyToken, type Tx } from "@nudge/core";

export type ProjectStatus = "planning" | "running" | "paused" | "gate" | "done";
export type MilestoneStatus = "planned" | "active" | "gate" | "merged";
export type TaskStatus = "todo" | "running" | "review" | "done" | "blocked" | "skipped";
export type CiState = "pending" | "passing" | "failing";

// Stored in a document, so plain JSON.
export type Milestone = {
  /** `m1`, `m2`, … within the project. */
  id: string;
  title: string;
  status: MilestoneStatus;
};

export type Task = {
  /** `t1`, `t2`, … within the project. */
  id: string;
  milestone: string;
  title: string;
  /** What has to hold for it to count as done. */
  criteria: string[];
  status: TaskStatus;
  /** `task/<id>`, once an agent works on it. */
  branch?: string;
  /** The agent's session, on the project's VM. */
  session?: { host: string; id: string };
  pr?: { url: string; number?: number; ci?: CiState };
  note?: string;
  /** When its agent last told the room something, or started. */
  heardAt?: number;
  /** When the supervisor last checked on a quiet agent. */
  checkedAt?: number;
};

export type Project = {
  name: string;
  status: ProjectStatus;
  /** Goal, what done means, stack, where it deploys, limits: as the interview found them. */
  brief: string;
  /** Such as `owner/name` on GitHub. */
  repo?: string;
  milestones: Milestone[];
  tasks: Task[];
  /** Who made it; wake-ups act for them. */
  owner: { playerId: string; displayName: string };
  vm?: {
    /** As exe.dev named it; also the machine's name in the acc extension. */
    name: string;
    /** What SSH reaches, such as `proj-x1.exe.xyz`. */
    host: string;
    user: string;
    /** Bootstrapped: agent CLIs there, repo cloned, env file written. */
    ready: boolean;
  };
  /** Names of the secrets set for it; the values are in the extension's secret store. */
  secrets: string[];
  budgetUsd?: number;
  /** The budget's warning level was reached and told. */
  budgetWarned?: true;
  maxAgents: number;
  startedAt: number;
  updatedAt: number;
  /** When the next digest goes out. */
  digestAt?: number;
  /** Wake-ups posted in the current hour: `[hourStart, count]`. */
  wakes?: [number, number];
};

export type ProjectState = { project?: Project };

/** A room's project, keyed by room id. */
export const ProjectDoc: SessionDocFamilyToken<ProjectState, null> = defineDocFamily({
  kind: "projects.room",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
});

export class ProjectError extends Error {
  override name = "ProjectError";
}

export const MAX_MILESTONES = 12;
export const MAX_TASKS = 120;

export type PlanDraft = {
  readonly title: string;
  readonly tasks: readonly { readonly title: string; readonly criteria?: readonly string[] }[];
}[];

/** The room's project, or throws. */
export async function projectIn(tx: Tx, roomId: string): Promise<Project> {
  const state = await tx.doc(ProjectDoc, roomId, null);
  if (state.project === undefined) throw new ProjectError("There is no project in this room.");
  return state.project;
}

export function newProject(
  name: string,
  owner: Project["owner"],
  maxAgents: number,
  now: number,
): Project {
  return {
    name,
    status: "planning",
    brief: "",
    milestones: [],
    tasks: [],
    owner: { ...owner },
    secrets: [],
    maxAgents,
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Replaces the milestones and the tasks not yet started. Tasks an agent worked on stay, in the
 * milestone they were in when it still exists, or the first one.
 */
export function setPlan(project: Project, plan: PlanDraft): void {
  if (project.status === "done") throw new ProjectError("The project is done.");
  if (plan.length === 0) throw new ProjectError("A plan needs at least one milestone.");
  if (plan.length > MAX_MILESTONES)
    throw new ProjectError(`A plan has at most ${MAX_MILESTONES} milestones.`);
  const count = plan.reduce((sum, milestone) => sum + milestone.tasks.length, 0);
  if (count > MAX_TASKS) throw new ProjectError(`A plan has at most ${MAX_TASKS} tasks.`);
  const merged = project.milestones.filter((milestone) => milestone.status === "merged");
  const started = project.tasks.filter((task) => task.status !== "todo");
  const milestones: Milestone[] = [...merged];
  const tasks: Task[] = [...started];
  for (const draft of plan) {
    const title = draft.title.trim();
    if (title === "") throw new ProjectError("Every milestone needs a title.");
    const kept = project.milestones.find(
      (milestone) =>
        milestone.status !== "merged" && milestone.title.toLowerCase() === title.toLowerCase(),
    );
    const milestone: Milestone = kept ?? {
      id: nextId("m", [...project.milestones, ...milestones]),
      title,
      status: "planned",
    };
    milestones.push({ ...milestone, title });
    for (const task of draft.tasks) {
      const taskTitle = task.title.trim();
      if (taskTitle === "") throw new ProjectError("Every task needs a title.");
      if (started.some((other) => other.title.toLowerCase() === taskTitle.toLowerCase())) continue;
      tasks.push({
        id: nextId("t", [...project.tasks, ...tasks]),
        milestone: milestone.id,
        title: taskTitle,
        criteria: (task.criteria ?? []).map((line) => line.trim()).filter((line) => line !== ""),
        status: "todo",
      });
    }
  }
  const ids = new Set(milestones.map((milestone) => milestone.id));
  for (const task of tasks) if (!ids.has(task.milestone)) task.milestone = milestones[0]!.id;
  project.milestones = milestones;
  project.tasks = tasks;
  if (project.status !== "planning" && !milestones.some((m) => m.status === "active"))
    activateNext(project);
}

/** `prefix` and one more than the highest number among `taken`'s ids. */
export function nextId(prefix: string, taken: readonly { readonly id: string }[]): string {
  const highest = Math.max(0, ...taken.map((item) => Number(item.id.slice(prefix.length)) || 0));
  return `${prefix}${highest + 1}`;
}

/** The milestone being worked on. */
export function activeMilestone(project: Project): Milestone | undefined {
  return project.milestones.find(
    (milestone) => milestone.status === "active" || milestone.status === "gate",
  );
}

/** Makes the first planned milestone active; false when every one is merged. */
export function activateNext(project: Project): boolean {
  const next = project.milestones.find((milestone) => milestone.status === "planned");
  if (next === undefined) return false;
  next.status = "active";
  return true;
}

export function tasksOf(project: Project, milestoneId: string): Task[] {
  return project.tasks.filter((task) => task.milestone === milestoneId);
}

/** Tasks an agent works on now. */
export function running(project: Project): Task[] {
  return project.tasks.filter((task) => task.status === "running" && task.session !== undefined);
}

/** Tasks of the active milestone no agent has started. */
export function ready(project: Project): Task[] {
  const milestone = activeMilestone(project);
  return milestone === undefined
    ? []
    : tasksOf(project, milestone.id).filter((task) => task.status === "todo");
}

/** Whether every task of the milestone is finished one way or another, and some have a PR. */
export function milestoneReady(project: Project, milestoneId: string): boolean {
  const tasks = tasksOf(project, milestoneId);
  return (
    tasks.length > 0 &&
    tasks.every((task) => ["review", "done", "skipped"].includes(task.status)) &&
    tasks.some((task) => task.pr !== undefined || task.status === "done")
  );
}

export function findTask(project: Project, id: string): Task {
  const task = project.tasks.find((candidate) => candidate.id === id.trim());
  if (task === undefined)
    throw new ProjectError(
      `No task "${id}"; there is ${project.tasks.map((t) => t.id).join(", ") || "none"}.`,
    );
  return task;
}

/** A VM name exe.dev takes, from the project's name: `proj-<slug>-<4 random>`. */
export function vmName(name: string, random: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return `proj-${slug || "x"}-${random}`;
}

/** The plan in a few lines, for the prompt and the plan gate. */
export function describePlan(project: Project): string {
  return project.milestones
    .map((milestone) => {
      const tasks = tasksOf(project, milestone.id);
      return (
        `${milestone.id} ${milestone.title} (${milestone.status}):\n` +
        tasks
          .map(
            (task) =>
              `  ${task.id} [${task.status}] ${task.title}` +
              (task.pr === undefined
                ? ""
                : ` — ${task.pr.url}${task.pr.ci ? ` (CI ${task.pr.ci})` : ""}`) +
              (task.session === undefined
                ? ""
                : ` — agent ${task.session.host}/${task.session.id}`) +
              (task.note === undefined ? "" : ` — ${task.note}`),
          )
          .join("\n")
      );
    })
    .join("\n");
}
