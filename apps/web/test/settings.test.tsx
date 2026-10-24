import type { ServerAssistant } from "@nudge/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { budgetDraftOf, budgetOf } from "../src/budget.ts";
import { routeTree } from "../src/routeTree.gen.ts";

// No socket and no server: the page shows what the test put in its queries.
vi.mock("../src/api.ts", async (original) => ({
  ...(await original<typeof import("../src/api.ts")>()),
  tokenFor: () => "nudge_token",
  useRoom: () => undefined,
  useConnection: () => ({ kind: "open" }),
  useRoomList: () => undefined,
}));

vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const robin: ServerAssistant = {
  name: "robin",
  displayName: "Robin",
  model: { provider: "anthropic", modelId: "claude" },
  budget: { monthlyUsd: 50, warnAt: 0.7, warnUsd: 40 },
  running: true,
};

/** The settings page of robin, rendered once, as Ann; `admin` says whether she is one. */
async function render({ admin = true, server = robin as ServerAssistant | undefined } = {}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["robin", "me"], {
    player: { id: "ann", displayName: "Ann" },
    admin,
    clientId: "web-1",
  });
  queryClient.setQueryData(["assistants"], {
    assistants: [{ name: "robin", displayName: "Robin" }],
  });
  if (server !== undefined) queryClient.setQueryData(["robin", "server-assistant"], server);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/robin/settings"] }),
  });
  await router.load();
  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(html).not.toContain("server rendering errored");
  return html;
}

describe("assistant settings: budget", () => {
  it("shows an admin the budget as the server has it", async () => {
    const html = await render();
    expect(html).toContain("Budget");
    expect(html).toContain("Monthly limit");
    expect(html).toContain('value="50"');
    expect(html).toContain('value="70"');
    expect(html).toContain('value="40"');
  });

  it("shows no budget to someone who isn't an admin", async () => {
    const html = await render({ admin: false });
    expect(html).toContain("Only an admin can change the assistant");
    expect(html).not.toContain("Monthly limit");
  });

  it("sends the whole budget, so a change keeps warnUsd", () => {
    const draft = { ...budgetDraftOf(robin.budget), monthlyUsd: "80" };
    expect(budgetOf(draft)).toEqual({ budget: { monthlyUsd: 80, warnAt: 0.7, warnUsd: 40 } });
    // With every field emptied, the defaults come back.
    expect(budgetOf(budgetDraftOf(undefined))).toEqual({ budget: null });
    expect(budgetOf({ ...draft, perPlayerUsd: "-3" })).toEqual({
      error: "The limit per person must be a number of dollars above 0",
    });
    expect(budgetOf({ ...draft, warnAtPercent: "150" })).toHaveProperty("error");
    expect(budgetDraftOf({ warnAt: 0.7 }).warnAtPercent).toBe("70");
  });
});
