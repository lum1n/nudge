import { type PanelSocket, type PanelSocketState, usePanelSocket } from "./panel-socket.ts";

/** A task as the panel shows it (`TaskView` in `@nudge/ext-projects`). */
export type TaskView = {
  id: string;
  title: string;
  criteria: string[];
  status: "todo" | "running" | "review" | "done" | "blocked" | "skipped";
  branch?: string;
  /** The coding agent working on it, on the project's VM. */
  session?: { host: string; id: string; state?: string };
  pr?: { url: string; number?: number; ci?: "pending" | "passing" | "failing" };
  note?: string;
};

export type MilestoneView = {
  id: string;
  title: string;
  status: "planned" | "active" | "gate" | "merged";
  tasks: TaskView[];
};

/** The room's project as the panel shows it (`ProjectView` in `@nudge/ext-projects`). */
export type ProjectView = {
  id: string;
  name: string;
  status: "planning" | "running" | "paused" | "gate" | "done";
  brief: string;
  repo?: string;
  milestones: MilestoneView[];
  vm?: { name: string; host: string; ready: boolean };
  /** The secrets' names; their values never reach the panel. */
  secrets: string[];
  spendUsd: number;
  budgetUsd?: number;
  maxAgents: number;
  updatedAt: number;
};

export type ProjectInput = { type: "pause" } | { type: "resume" };

type ProjectFrame = { type: "project"; project: ProjectView | null };

export type ProjectSocket = PanelSocket<ProjectView | null, ProjectInput, ProjectFrame>;

/** One room's project, or `null` while it has none, kept current by the server. */
export function useProject(
  assistant: string,
  room: string,
): [ProjectSocket | undefined, PanelSocketState<ProjectView | null>] {
  return usePanelSocket<ProjectView | null, ProjectInput, ProjectFrame>(
    assistant,
    room,
    "projects",
    (frame) => (frame.type === "project" ? frame.project : undefined),
  );
}
