import type { PendingMessage, RoomState, RoomView, TimelineItem } from "@nudge/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "../src/routeTree.gen.ts";

/** What the mocked connection gives the page: the room it holds, and the socket's status. */
const page = vi.hoisted(() => ({
  held: undefined as { store: unknown; state: unknown } | undefined,
  connection: { kind: "open" } as { kind: string; code?: number; reason?: string },
}));

// No socket: the room is whatever the test holds.
vi.mock("../src/api.ts", async (original) => ({
  ...(await original<typeof import("../src/api.ts")>()),
  tokenFor: () => "nudge_token",
  useRoom: () => page.held,
  useConnection: () => page.connection,
  useRoomList: () => undefined,
}));

// The robot asks whether the reader wants less motion, and the composer about the pointer.
vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

afterEach(() => {
  page.held = undefined;
  page.connection = { kind: "open" };
});

/** The room page at /robin/<room>, rendered once, as Ann; `admin` says whether she is one. */
async function render(room = "trip", { admin = true } = {}): Promise<string> {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["robin", "me"], {
    player: { id: "ann", displayName: "Ann" },
    admin,
    clientId: "web-1",
  });
  queryClient.setQueryData(["assistants"], {
    assistants: [{ name: "robin", displayName: "Robin" }],
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/robin/${room}`] }),
  });
  await router.load();
  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // A render that failed on the server says so in a template, and shows nothing.
  expect(html).not.toContain("server rendering errored");
  return html;
}

/** The page's text, as a reader sees it: no tags, one space between words. */
const text = (html: string) =>
  html
    .replace(/<svg.*?<\/svg>/gs, "")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const now = Date.now();
const kim = { id: "kim", displayName: "Kim", address: "kim@nudge.example.com/robin" };
const asked: TimelineItem = {
  type: "user",
  id: "e1",
  text: "Where do we sleep?",
  author: kim,
  sentAt: now - 60_000,
};
const answered: TimelineItem = {
  type: "answer",
  id: "a1",
  status: "done",
  parts: [{ type: "text", text: "In **Reine**, at ⟦PLACE:1⟧." }],
  startedAt: now - 59_000,
};

const view = (over: Partial<RoomView> = {}): RoomView => ({
  room: {
    id: "trip",
    kind: "shared",
    name: "Lofoten trip",
    members: [{ id: "ann", displayName: "Ann" }, kim],
  },
  timeline: [asked, answered],
  hasEarlier: false,
  live: { running: false },
  queue: [],
  approvals: [],
  memory: [],
  nudges: [],
  ...over,
});

/** Holds `room` as the client's store would, with `pending` messages not yet in its view. */
function hold(room: RoomView, pending: PendingMessage[] = []): void {
  const state = {
    status: "live",
    view: room,
    timeline: room.timeline,
    earlier: [],
    canLoadEarlier: room.hasEarlier,
    loadingEarlier: false,
    pending,
  } satisfies Partial<RoomState>;
  page.held = { store: {}, state };
}

describe("the room page", () => {
  it("says it is connecting until the room's view comes", async () => {
    expect(text(await render())).toContain("Connecting…");
    page.connection = { kind: "closed", code: 1011, reason: "server error" };
    expect(text(await render())).toContain("Disconnected: server error.");
  });

  it("says when the room is gone, or Ann was removed from it", async () => {
    page.held = { store: {}, state: { status: "gone", reason: "removed" } };
    expect(text(await render())).toContain("You were removed from this room.");
    page.held = { store: {}, state: { status: "gone", reason: "missing" } };
    expect(text(await render())).toContain("No such room.");
  });

  it("shows the room's name and members, where they are from, and its pages", async () => {
    hold(view());
    const html = await render();
    expect(text(html)).toContain("Lofoten trip Rename");
    expect(text(html)).toContain("Ann , Kim (from nudge.example.com/robin)");
    for (const sub of ["activity", "browser", "desktop", "connectors", "mcp", "lists"])
      expect(html).toContain(`href="/robin/trip/${sub}"`);
    expect(html).toContain('href="/robin/trip/documents"');
    expect(html).toContain('href="/robin/trip/model"');
  });

  it("lets only an admin rename the lobby", async () => {
    const lobby = view({ room: { id: "lobby", kind: "lobby", name: "Lobby", members: [] } });
    hold(lobby);
    expect(text(await render("lobby", { admin: true }))).toContain("Lobby Rename");
    expect(text(await render("lobby", { admin: false }))).not.toContain("Rename");
    hold(view());
    expect(text(await render("trip", { admin: false }))).toContain("Lofoten trip Rename");
  });

  it("shows the chat: who said what, the answer as markdown, and hidden values as chips", async () => {
    hold(view());
    const html = await render();
    expect(text(html)).toContain("Kim Where do we sleep?");
    expect(html).toContain("<strong>Reine</strong>");
    // The placeholder, not a link to it.
    expect(html).toContain('title="Hidden from you (⟦PLACE:1⟧)"');
    expect(html).not.toContain('href="#hidden"');
    expect(text(html)).toContain(" Robin ");
  });

  it("offers dictation only where the browser recognizes speech", async () => {
    hold(view());
    expect(text(await render())).not.toContain("Dictate");
    vi.stubGlobal("window", { SpeechRecognition: class {} });
    try {
      hold(view());
      expect(text(await render())).toContain("Dictate");
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    }
  });

  it("greets an empty room with the robot", async () => {
    hold(view({ timeline: [] }));
    expect(text(await render())).toContain("Say hello to Robin.");
  });

  it("marks an answer to a nudge, and one only Ann sees", async () => {
    hold(
      view({
        timeline: [
          { ...answered, id: "a2", promptedBy: "nudge" },
          {
            ...answered,
            id: "a3",
            privateTo: { id: "ann", displayName: "Ann" },
            parts: [{ type: "text", text: "Your PIN is safe." }],
          },
        ],
      }),
    );
    const shown = text(await render());
    expect(shown).toContain("Robin 🔔 Nudge");
    expect(shown).toContain("🔒 Only you Your PIN is safe.");
  });

  it("puts pending approvals in the sidebar, with Approve and Deny, and counts them on Room", async () => {
    hold(
      view({
        approvals: [
          { id: "a2", summary: "Book the cabin in Reine", status: "pending", requestedAt: now },
          {
            id: "a1",
            summary: "Rent a car",
            status: "approved",
            requestedAt: now - 1000,
            decidedBy: { id: "kim", displayName: "Kim" },
          },
        ],
      }),
    );
    const shown = text(await render());
    expect(shown).toContain("Waiting for approval Book the cabin in Reine Approve Deny");
    expect(shown).not.toContain("Rent a car");
    expect(shown).toContain("Room 1 waiting for approval");
    expect(shown).toContain("Waiting for an approval");
  });

  it("says what the assistant is doing, and offers Stop while it runs", async () => {
    hold(
      view({
        live: {
          running: true,
          status: { kind: "retrying", attempt: 2, error: "overloaded", at: now },
        },
      }),
    );
    let shown = text(await render());
    expect(shown).toContain("Retrying (attempt 2): overloaded");
    expect(shown).toContain("Trying again…");
    expect(shown).toContain("Stop");
    expect(shown).not.toMatch(/\bSend\b/);

    const browsing: TimelineItem = {
      type: "answer",
      id: "a2",
      status: "running",
      parts: [
        { type: "tool", callId: "c1", name: "browse", args: { task: "Cabins" }, status: "running" },
      ],
    };
    hold(view({ live: { running: true }, timeline: [asked, browsing] }));
    shown = text(await render());
    expect(shown).toContain("Using browse…");
    expect(shown).toContain("Working… · what it's doing");

    hold(view({ live: { running: false, status: { kind: "compaction-failed", error: "no" } } }));
    shown = text(await render());
    expect(shown).toContain("Couldn't summarize older messages: no");
    expect(shown).toMatch(/\bSend\b/);
  });

  it("offers a send that failed again, or to let it go", async () => {
    hold(view(), [
      { requestId: "r1", text: "Is there a sauna?", error: "offline" },
      { requestId: "r2", text: "Still sending" },
    ]);
    const shown = text(await render());
    expect(shown).toContain("Not sent: Is there a sauna? (offline) Retry Dismiss");
    expect(shown).not.toContain("Not sent: Still sending");
  });

  it("offers private messages only where someone else could read along", async () => {
    hold(view());
    let html = await render();
    expect(html).toContain('aria-pressed="false"');
    expect(text(html)).toContain("Private");
    hold(
      view({
        room: {
          id: "me",
          kind: "personal",
          name: "Ann",
          members: [{ id: "ann", displayName: "Ann" }],
        },
      }),
    );
    html = await render("me");
    expect(html).not.toContain("aria-pressed");
  });

  it("says when it is reconnecting", async () => {
    hold(view());
    page.connection = { kind: "waiting" };
    expect(text(await render())).toContain("Reconnecting…");
  });
});
