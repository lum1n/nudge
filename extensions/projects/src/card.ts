import { type UiBlock, type UiCard, UI_CARD_MAX_CHARS } from "@nudge/core";
import { type Project, type Task, tasksOf } from "./model.ts";

/** Most steps a timeline takes. */
const MAX_STEPS = 20;

const cut = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const money = (usd: number): string => `$${usd.toFixed(2)}`;

function stateOf(task: Task): "done" | "current" | "upcoming" {
  if (task.status === "done") return "done";
  return task.status === "running" || task.status === "review" ? "current" : "upcoming";
}

/** What a task's agent and PR are doing, for a timeline step's subtitle. */
function subtitleOf(task: Task, agentState: string | undefined): string {
  const parts: string[] = [task.status];
  if (task.session !== undefined)
    parts.push(`agent ${task.session.id}${agentState === undefined ? "" : ` ${agentState}`}`);
  if (task.pr !== undefined)
    parts.push(
      `PR${task.pr.number === undefined ? "" : ` #${task.pr.number}`}${task.pr.ci ? ` (CI ${task.pr.ci})` : ""}`,
    );
  if (task.note !== undefined) parts.push(task.note);
  return cut(parts.join(" · "), 120);
}

/**
 * The project as a card for `project_status`: headline numbers, a bar per milestone and the
 * tasks in order with what their agents do. `agents` has each running agent's state by task id.
 * Undefined when there is no plan yet, or the card would be too big to show.
 */
export function projectCard(
  project: Project,
  spendUsd: number,
  agents: ReadonlyMap<string, string> = new Map(),
): UiCard | undefined {
  const tasks = project.tasks.filter((task) => task.status !== "skipped");
  if (tasks.length === 0) return undefined;
  const done = tasks.filter((task) => task.status === "done").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const overBudget = project.budgetUsd !== undefined && spendUsd > project.budgetUsd;

  const blocks: UiBlock[] = [
    {
      type: "stats",
      items: [
        { label: "Status", value: project.status },
        { label: "Tasks done", value: `${done} of ${tasks.length}` },
        { label: "Agents running", value: String(running) },
        ...(blocked === 0
          ? []
          : [{ label: "Blocked", value: String(blocked), tone: "bad" as const }]),
        {
          label: "Spent",
          value: money(spendUsd),
          ...(project.budgetUsd === undefined ? {} : { change: `of ${money(project.budgetUsd)}` }),
          tone: overBudget ? ("bad" as const) : ("neutral" as const),
        },
      ],
    },
  ];

  const bars = [
    ...project.milestones.slice(0, 9).map((milestone) => {
      const own = tasksOf(project, milestone.id).filter((task) => task.status !== "skipped");
      const finished = own.filter((task) => task.status === "done").length;
      return {
        label: cut(milestone.title, 100),
        value: finished,
        max: Math.max(own.length, 1),
        note: `${finished} of ${own.length}`,
      };
    }),
    ...(project.budgetUsd === undefined
      ? []
      : [
          {
            label: "Budget",
            value: spendUsd,
            max: project.budgetUsd,
            note: `${money(spendUsd)} of ${money(project.budgetUsd)}`,
          },
        ]),
  ].slice(0, 10);
  if (bars.length > 0) blocks.push({ type: "progress", items: bars });

  // Over the limit, drop what is done longest ago, then what comes last.
  const steps = [...tasks];
  while (steps.length > MAX_STEPS) {
    const old = steps.findIndex((task) => task.status === "done");
    steps.splice(old === -1 ? steps.length - 1 : old, 1);
  }
  blocks.push({
    type: "timeline",
    items: steps.map((task) => ({
      title: cut(`${task.id} ${task.title}`, 60),
      subtitle: subtitleOf(task, agents.get(task.id)),
      state: stateOf(task),
    })),
  });

  const card: UiCard = { v: 1, title: cut(project.name, 200), blocks };
  return JSON.stringify(card).length > UI_CARD_MAX_CHARS ? undefined : card;
}
