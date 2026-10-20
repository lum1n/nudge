import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { Approval, ScheduledNudge } from "@nudge/core";
import * as core from "@nudge/core";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { apply, diff, RoomView, type TimelineItem } from "../src/index.ts";
import {
  APPROVAL_ENTRY,
  FIRE_ENTRY,
  MESSAGE_ENTRY,
  projectRoomList,
  projectTimeline,
  RoomProjector,
  type RoomSources,
  TimelinePager,
  TOOL_OUTPUT_LIMIT,
  windowStart,
} from "../src/project.ts";
import { replay } from "./replay.ts";

const views = replay();
const room = {
  id: "trip",
  kind: "shared" as const,
  name: "Trip",
  members: [
    { id: "ann", displayName: "Ann" },
    { id: "bo", displayName: "Bo" },
  ],
};
const sources = (view: ConversationView, more: Partial<RoomSources> = {}): RoomSources => ({
  room,
  view,
  approvals: [],
  memory: [],
  nudges: [],
  ...more,
});
const projectAll = () => {
  const projector = new RoomProjector();
  return views.map((view) => projector.project(sources(view)));
};
/** The last view with `entries` in place of the recorded ones. */
const withEntries = (entries: readonly unknown[]) =>
  ({ ...views.at(-1)!, entries }) as unknown as ConversationView;

const summary = (item: TimelineItem) => {
  switch (item.type) {
    case "answer":
      return `answer(${item.status}): ${item.parts.map((p) => (p.type === "tool" ? `${p.name}()` : p.text)).join(" | ")}`;
    case "user":
      return `${item.author?.displayName}: ${item.text}`;
    case "nudge":
      return `nudge: ${item.text}`;
    case "approval":
      return `approval ${item.approvalId} ${item.status}: ${item.summary}`;
    case "marker":
      return `marker: ${item.kind}`;
  }
};

describe("RoomProjector", () => {
  it("shows the run as a timeline: authors, an answer with its tool round, and the fired nudge", () => {
    const view = projectAll().at(-1)!;
    expect(view.timeline.map(summary)).toEqual([
      "Ann: Remember that I like tea",
      "answer(done): Ann wants this kept. | I'll note that. | remember() | Noted: Ann likes tea.",
      "Bo: I like coffee",
      "answer(done): And Bo likes coffee.",
      "nudge: Kettle",
      "answer(done): Time to put the kettle on!",
    ]);
    const answer = view.timeline[1] as Extract<TimelineItem, { type: "answer" }>;
    expect(answer.parts[0]).toMatchObject({ type: "reasoning" });
    expect(answer.parts[2]).toMatchObject({
      type: "tool",
      name: "remember",
      args: { fact: "Ann likes tea" },
      status: "done",
      isError: false,
    });
    expect((answer.parts[2] as { result?: string }).result).toBeTruthy();
    expect(view.live).toEqual({ running: false });
    expect(view.queue).toEqual([]);
    expect(view.hasEarlier).toBe(false);
  });

  it("carries who sent a message and the request id they chose", () => {
    const first = projectAll().at(-1)!.timeline[0]!;
    expect(first).toMatchObject({
      type: "user",
      id: expect.stringMatching(/^entry:/),
      author: { id: "ann", displayName: "Ann" },
      requestId: "1",
      clientId: expect.stringMatching(/^client-/),
      sentAt: expect.any(Number),
    });
  });

  it("shows the answer in flight, and its tool call while it runs", () => {
    const projected = projectAll();
    const trailing = (view: RoomView) => view.timeline.at(-1);

    const thinking = projected.find((view) => {
      const last = trailing(view);
      return last?.type === "answer" && last.parts.some((part) => part.type === "reasoning");
    })!;
    expect(thinking.live.running).toBe(true);
    expect(trailing(thinking)).toMatchObject({ type: "answer", status: "running" });

    const running = projected.find((view) => {
      const last = trailing(view);
      return (
        last?.type === "answer" &&
        last.parts.some((part) => part.type === "tool" && part.status === "running")
      );
    });
    expect(running).toBeDefined();
    expect(trailing(running!)).toMatchObject({ status: "running" });

    // The answer in flight keeps its id once its entry is written.
    const ids = new Set(
      projected.flatMap((view) =>
        view.timeline.filter((item) => item.type === "answer").map((item) => item.id),
      ),
    );
    expect(ids.size).toBe(3);
  });

  it("lists Bo's message as queued while the assistant is busy", () => {
    const queued = projectAll().find((view) => view.queue.length > 0)!;
    expect(queued.live.running).toBe(true);
    expect(queued.queue).toMatchObject([
      {
        mode: "followUp",
        text: "I like coffee",
        author: { id: "bo", displayName: "Bo" },
        nudge: false,
      },
    ]);
  });

  it("hands back the same objects while their sources stay the same", () => {
    const projected = projectAll();
    const first = projected.find((view) => view.timeline.length > 0)!.timeline[0]!;
    for (const view of projected.filter((v) => v.timeline.length > 0))
      expect(view.timeline[0]).toBe(first);
    expect(projected.at(-2)!.timeline[1]).toBe(projected.at(-1)!.timeline[1]);
    expect(projected.at(-2)!.queue).toBe(projected.at(-1)!.queue);
  });

  it("projects views that fit the schema", () => {
    for (const view of projectAll()) expect(Value.Errors(RoomView, view)).toEqual([]);
  });

  it("streams as patches: apply(diff) gives each next view, growing text by appends", () => {
    const projected = projectAll();
    const ops = projected.slice(1).map((view, i) => diff(projected[i], view));
    let mirror = projected[0];
    for (const [i, frame] of ops.entries()) {
      mirror = apply(mirror, frame);
      expect(mirror).toEqual(projected[i + 1]);
    }
    expect(ops.flat().some((op) => op.op === "append")).toBe(true);
    // No frame sends the whole view or timeline again.
    for (const op of ops.flat()) expect(op.path.length).toBeGreaterThan(op.op === "set" ? 1 : 0);
  });

  it("marks stopped and failed answers, and where the transcript starts over", () => {
    const assistant = (stopReason: string, id: number, errorMessage?: string) => ({
      id,
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Half an ans" }],
          stopReason,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        },
      ],
    });
    const view = new RoomProjector().project(
      sources(
        withEntries([
          { id: 1, conversationId: 1, kind: "pi.compaction", data: {} },
          { id: 2, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
          assistant("aborted", 3),
          {
            id: 4,
            conversationId: 1,
            kind: "pi.user",
            model: [{ role: "user", content: "again" }],
          },
          assistant("error", 5, "Overloaded"),
        ]),
      ),
    );
    expect(view.timeline.map(summary)).toEqual([
      "marker: compacted",
      "undefined: hi",
      "answer(stopped): Half an ans",
      "undefined: again",
      "answer(failed): Half an ans",
    ]);
    expect(view.timeline[4]).toMatchObject({ error: "Overloaded" });
    expect(view.hasEarlier).toBe(true);
  });

  it("keeps the most recent items and says there are earlier ones", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      conversationId: 1,
      kind: "pi.user",
      model: [{ role: "user", content: `m${i + 1}` }],
    }));
    const view = new RoomProjector(3).project(sources(withEntries(entries)));
    expect(view.timeline.map((item) => item.id)).toEqual(["entry:3", "entry:4", "entry:5"]);
    expect(view.hasEarlier).toBe(true);
  });

  it("carries a tool result's details, and cuts what is too long", () => {
    const call = (id: string) => ({
      id: Number(id.slice(1)),
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id, name: "browse", arguments: { task: "x" } }],
          stopReason: "toolUse",
        },
      ],
    });
    const result = (id: string, text: string, details: unknown) => ({
      id: Number(id.slice(1)) + 100,
      conversationId: 1,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: id,
          toolName: "browse",
          content: [{ type: "text", text }],
          details,
          isError: false,
        },
      ],
    });
    const long = "x".repeat(TOOL_OUTPUT_LIMIT + 10);
    const view = new RoomProjector().project(
      sources(
        withEntries([
          { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "go" }] },
          call("c2"),
          result("c2", "Login needed on finn.no", { needsLogin: true }),
          call("c3"),
          result("c3", long, { page: long }),
        ]),
      ),
    );
    const answer = view.timeline.at(-1) as Extract<TimelineItem, { type: "answer" }>;
    expect(answer.parts[0]).toMatchObject({ details: { needsLogin: true } });
    expect(answer.parts[0]).not.toHaveProperty("truncated");
    expect(answer.parts[1]).toMatchObject({ truncated: true });
    expect(answer.parts[1]).not.toHaveProperty("details");
    expect((answer.parts[1] as { result: string }).result).toHaveLength(TOOL_OUTPUT_LIMIT);
  });

  it("shows how an approval ended between the answers around it", () => {
    const view = new RoomProjector().project(
      sources(
        withEntries([
          {
            id: 1,
            conversationId: 1,
            kind: "pi.user",
            model: [{ role: "user", content: "mail Ann" }],
          },
          {
            id: 2,
            conversationId: 1,
            kind: APPROVAL_ENTRY,
            data: { id: "a1", summary: "Send a mail to Ann", status: "done", decidedBy: "Bo" },
            model: [{ role: "user", content: "Bo approved a1" }],
          },
        ]),
      ),
    );
    expect(view.timeline.map(summary)).toEqual([
      "undefined: mail Ann",
      "approval a1 done: Send a mail to Ann",
    ]);
    expect(view.timeline.at(-1)).toMatchObject({ decidedBy: "Bo" });
  });

  it("lists pending approvals and the latest decided, memory, and nudges soonest first", () => {
    const approval = (n: number, status: Approval["status"]): Approval => ({
      id: `a${n}`,
      extension: "mail",
      kind: "send",
      summary: `Mail ${n}`,
      payload: { secret: "not for clients" },
      requestedAt: n,
      status,
      ...(status === "pending"
        ? {}
        : { decidedBy: { playerId: "bo", displayName: "Bo" }, decidedAt: n + 1 }),
    });
    const approvals = [
      approval(13, "pending"),
      ...Array.from({ length: 12 }, (_, i) => approval(12 - i, "done")),
      approval(0, "pending"),
    ];
    const nudge = (id: string, fireAt: number): ScheduledNudge => ({
      id,
      roomId: "trip",
      conversationId: 1,
      message: `n${id}`,
      fireAt,
      createdAt: 0,
    });
    const view = new RoomProjector().project(
      sources(views.at(-1)!, {
        approvals,
        memory: [{ id: "m1", text: "Ann likes tea", createdAt: 5 }],
        nudges: [nudge("2", 20), { ...nudge("1", 10), every: 60_000 }],
      }),
    );
    expect(view.approvals.map((a) => a.id)).toEqual([
      "a13",
      ...Array.from({ length: 10 }, (_, i) => `a${12 - i}`),
      "a0",
    ]);
    expect(view.approvals[1]).toEqual({
      id: "a12",
      summary: "Mail 12",
      status: "done",
      requestedAt: 12,
      decidedBy: { id: "bo", displayName: "Bo" },
      decidedAt: 13,
    });
    expect(view.memory).toEqual([{ id: "m1", text: "Ann likes tea", createdAt: 5 }]);
    expect(view.nudges).toEqual([
      { id: "1", message: "n1", fireAt: 10, every: 60_000 },
      { id: "2", message: "n2", fireAt: 20 },
    ]);
    expect(Value.Errors(RoomView, view)).toEqual([]);
  });

  it("reads the entry kinds core writes", () => {
    expect([MESSAGE_ENTRY, FIRE_ENTRY, APPROVAL_ENTRY]).toEqual([
      core.MESSAGE_ENTRY,
      core.FIRE_ENTRY,
      core.APPROVAL_ENTRY,
    ]);
  });
});

describe("projectTimeline", () => {
  it("names an answer after the item before the page, as the room view does", () => {
    const entries = views.at(-1)!.entries;
    const whole = projectTimeline(entries);
    const at = entries.findIndex((entry) => entry.kind === FIRE_ENTRY);
    const page = projectTimeline(entries.slice(at + 1), {
      after: `entry:${entries[at]!.id}`,
      afterEntry: entries[at],
    });
    expect(page).toEqual(whole.slice(-1));
    expect(page[0]!.id).toBe(
      new RoomProjector().project(sources(views.at(-1)!)).timeline.at(-1)!.id,
    );
  });

  it("says an answer to a fired nudge or a watch was prompted by it, and one to a message not", () => {
    const entries = views.at(-1)!.entries as EntryRecord[];
    const answers = (items: TimelineItem[]) =>
      items.flatMap((item) => (item.type === "answer" ? [item.promptedBy] : []));
    expect(answers(projectTimeline(entries))).toEqual([undefined, undefined, "nudge"]);
    const watched = entries.map((entry) =>
      entry.kind === FIRE_ENTRY
        ? { ...entry, data: { ...(entry.data as object), source: "watch" } }
        : entry,
    );
    expect(answers(projectTimeline(watched))).toEqual([undefined, undefined, "watch"]);
  });

  it("ends answers by how they stopped, never as running", () => {
    const entries = views.find((view) => {
      const live = view.docs["pi.live"] as { run?: unknown } | undefined;
      return live?.run !== undefined && view.entries.some((e) => e.kind === "pi.assistant");
    })!.entries as EntryRecord[];
    expect(
      projectTimeline(entries).some((item) => item.type === "answer" && item.status === "running"),
    ).toBe(false);
  });
});

describe("TimelinePager", () => {
  it("pages back from the room view's window to the start without gaps or repeats", () => {
    const last = views.at(-1)!;
    // The recorded run three times over, for more items than one page.
    const span = last.entries.at(-1)!.id;
    const entries = [0, 1, 2].flatMap((copy) =>
      last.entries.map((entry) => ({ ...entry, id: entry.id + copy * span })),
    ) as EntryRecord[];
    const view = { ...last, entries } as ConversationView;
    const whole = projectTimeline(entries);
    expect(whole.length).toBe(18);

    for (const window of [1, 2, 5, 18, 30])
      for (const limit of [1, 2, 3, 10]) {
        const shown = new RoomProjector(window).project(sources(view)).timeline;
        const pages: TimelineItem[][] = [];
        let before = windowStart(view, window);
        while (before !== undefined) {
          const pager = new TimelinePager(limit);
          for (const entry of [...entries].reverse())
            if (entry.id < before && !pager.add(entry)) break;
          const page = pager.page();
          expect(page.items.length).toBeLessThanOrEqual(limit + 1);
          if (page.before !== undefined) expect(page.items.length).toBeGreaterThanOrEqual(limit);
          pages.unshift(page.items);
          before = page.before;
        }
        expect([...pages.flat(), ...shown]).toEqual(whole);
      }
  });

  it("starts the window at the answer in flight's place", () => {
    const view = views.find((view) => {
      const live = view.docs["pi.live"] as { run?: unknown } | undefined;
      return live?.run !== undefined;
    })!;
    const shown = new RoomProjector(2).project(sources(view)).timeline;
    const start = windowStart(view, 2)!;
    const older = projectTimeline(view.entries.filter((entry) => entry.id < start));
    expect([...older, ...shown].map((item) => item.id)).toEqual(
      new RoomProjector(1000).project(sources(view)).timeline.map((item) => item.id),
    );
  });
});

describe("projectRoomList", () => {
  it("lists the player's rooms and nudges soonest first", () => {
    const roomList = projectRoomList({
      player: { id: "ann", displayName: "Ann" },
      rooms: [{ room, running: true, pendingApprovals: 1, lastItemAt: 5 }],
      nudges: [
        { id: "2", roomId: "trip", conversationId: 1, message: "b", fireAt: 20, createdAt: 0 },
        { id: "1", roomId: "trip", conversationId: 1, message: "a", fireAt: 10, createdAt: 0 },
      ],
    });
    expect(roomList.nudges).toEqual([
      { id: "1", roomId: "trip", message: "a", fireAt: 10 },
      { id: "2", roomId: "trip", message: "b", fireAt: 20 },
    ]);
  });
});
