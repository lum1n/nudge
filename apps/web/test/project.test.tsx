import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "../src/project.ts";
import { routeTree } from "../src/routeTree.gen.ts";

/** What the mocked socket has: the project, `null` for none, `undefined` while connecting. */
const panel = vi.hoisted(() => ({ view: undefined as ProjectView | null | undefined }));

vi.mock("../src/api.ts", async (original) => ({
  ...(await original<typeof import("../src/api.ts")>()),
  tokenFor: () => "nudge_token",
  useConnection: () => ({ kind: "open" }),
  useRoomList: () => undefined,
}));

vi.mock("../src/project.ts", () => ({
  useProject: () => [{ send: () => {} }, { status: "open", view: panel.view }],
}));

vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

afterEach(() => {
  panel.view = undefined;
});

async function render(): Promise<string> {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["robin", "me"], {
    player: { id: "ann", displayName: "Ann" },
    admin: true,
    clientId: "web-1",
  });
  queryClient.setQueryData(["assistants"], {
    assistants: [{ name: "robin", displayName: "Robin" }],
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/robin/site/project"] }),
  });
  await router.load();
  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(html).not.toContain("server rendering errored");
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const project: ProjectView = {
  id: "p1",
  name: "Nudge site",
  status: "running",
  brief: "A landing page.\nWith a waitlist.",
  repo: "github.com/ann/site",
  milestones: [
    {
      id: "m1",
      title: "First page",
      status: "active",
      tasks: [
        {
          id: "t1",
          title: "Hero section",
          criteria: ["Loads fast", "Works on phones"],
          status: "review",
          branch: "hero",
          session: { host: "site.exe.xyz", id: "s1", state: "idle" },
          pr: { url: "https://github.com/ann/site/pull/3", number: 3, ci: "passing" },
          note: "Waiting on copy",
        },
      ],
    },
  ],
  vm: { name: "site", host: "site.exe.xyz", ready: true },
  secrets: ["GITHUB_TOKEN"],
  spendUsd: 1.5,
  budgetUsd: 20,
  maxAgents: 2,
  updatedAt: 0,
};

describe("the project page", () => {
  it("says when the room has no project", async () => {
    panel.view = null;
    expect(await render()).toContain(
      "No project in this room yet. Ask the assistant to start one.",
    );
  });

  it("shows the project, its tasks, agents, VM, secret names and spend", async () => {
    panel.view = project;
    const shown = await render();
    expect(shown).toContain("Nudge site running Pause");
    expect(shown).toContain("First page active");
    expect(shown).toContain("in review Hero section 2 criteria");
    expect(shown).not.toContain("Loads fast");
    expect(shown).toContain("Branch: hero PR #3 · CI passing");
    expect(shown).toContain("Agents working Hero section s1 on site.exe.xyz · idle");
    expect(shown).toContain("VM site · site.exe.xyz · ready");
    expect(shown).toContain("GITHUB_TOKEN Only their names show here.");
    expect(shown).toContain("$1.50 of $20.00");
    expect(shown).toContain("At most 2 agents at once");
  });

  it("offers Resume while paused", async () => {
    panel.view = { ...project, status: "paused" };
    expect(await render()).toContain("Nudge site paused Resume");
  });
});
