import { cardProblem } from "@nudge/core";
import { describe, expect, it } from "vitest";
import { projectCard } from "../src/card.ts";
import { newProject, type Project, setPlan } from "../src/index.ts";

function planned(tasks: number, budgetUsd?: number): Project {
  const project = newProject("Shop", { playerId: "p1", displayName: "Ann" }, 2, 0);
  setPlan(project, [
    {
      title: "Build",
      tasks: Array.from({ length: tasks }, (_, i) => ({ title: `Task ${i + 1}` })),
    },
  ]);
  if (budgetUsd !== undefined) project.budgetUsd = budgetUsd;
  return project;
}

describe("projectCard", () => {
  it("has no card before there is a plan", () => {
    expect(projectCard(newProject("Shop", { playerId: "p1", displayName: "Ann" }, 2, 0), 0)).toBe(
      undefined,
    );
  });

  it("shows stats, progress and a timeline of the tasks", () => {
    const project = planned(3, 10);
    project.tasks[0]!.status = "done";
    project.tasks[1]!.status = "running";
    project.tasks[1]!.session = { host: "vm", id: "s9" };
    const card = projectCard(project, 12, new Map([["t2", "working"]]));
    expect(cardProblem(card)).toBeUndefined();
    const [stats, progress, timeline] = card!.blocks!;
    expect(stats).toMatchObject({
      type: "stats",
      items: expect.arrayContaining([
        { label: "Tasks done", value: "1 of 3" },
        { label: "Spent", value: "$12.00", change: "of $10.00", tone: "bad" },
      ]),
    });
    expect(progress).toMatchObject({
      type: "progress",
      items: [
        { value: 1, max: 3 },
        { label: "Budget", value: 12, max: 10 },
      ],
    });
    expect(timeline).toMatchObject({
      type: "timeline",
      items: [{ state: "done" }, { state: "current" }, { state: "upcoming" }],
    });
    expect(JSON.stringify(timeline)).toContain("agent s9 working");
  });

  it("keeps a long plan to 20 steps", () => {
    const project = planned(30);
    project.tasks.slice(0, 5).forEach((task) => (task.status = "done"));
    const card = projectCard(project, 0);
    expect(cardProblem(card)).toBeUndefined();
    const timeline = card!.blocks!.at(-1) as { items: { title: string }[] };
    expect(timeline.items).toHaveLength(20);
    expect(timeline.items[0]!.title).toContain("t6");
    expect(timeline.items.at(-1)!.title).toContain("t25");
  });
});
