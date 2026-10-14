import { readFile } from "node:fs/promises";
import type { RoomView, ServerFrame, TimelineItem, TimelineResponse } from "@nudge/protocol";
import { describe, expect, it } from "vitest";
import { HomeStore, RoomStore, slide, type TargetFrame, type ViewStore } from "../src/index.ts";

/** Ann's socket in a recorded run of room "trip" and her home; see the protocol's stream test. */
async function recording(): Promise<{ frame: ServerFrame; view?: unknown }[]> {
  const url = new URL("../../protocol/test/fixtures/room-stream.jsonl", import.meta.url);
  return (await readFile(url, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { frame: ServerFrame; view?: unknown });
}

const user = (n: number): TimelineItem => ({ type: "user", id: `m${n}`, text: `Message ${n}` });
const users = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => user(from + n));

function roomView(timeline: TimelineItem[], extra: Partial<RoomView> = {}): RoomView {
  return {
    room: { id: "trip", kind: "shared", name: "Trip", members: [] },
    timeline,
    hasEarlier: true,
    live: { running: false },
    queue: [],
    approvals: [],
    memory: [],
    nudges: [],
    ...extra,
  };
}

const snapshot = (view: RoomView, seq = 0): TargetFrame => ({
  type: "snapshot",
  target: "room:trip",
  seq,
  view,
});

describe("view stores", () => {
  it("rebuild every recorded view from the recorded frames", async () => {
    const stores = new Map<string, ViewStore<unknown>>([
      ["home", new HomeStore()],
      ["room:trip", new RoomStore("trip")],
    ]);
    let checked = 0;
    for (const { frame, view } of await recording()) {
      if (frame.type !== "snapshot" && frame.type !== "patch") continue;
      const store = stores.get(frame.target)!;
      const before = store.getState();
      expect(store.receive(frame)).toBe(true);
      expect(store.getState()).not.toBe(before);
      expect(store.getState()).toMatchObject({ status: "live", view });
      checked += 1;
    }
    expect(checked).toBeGreaterThan(4);
    const room = (stores.get("room:trip") as RoomStore).getState();
    expect(room.timeline).toBe(room.view!.timeline);
  });

  it("ask for a new snapshot on a gap or a patch that doesn't fit, and ignore patches meanwhile", () => {
    const store = new RoomStore("trip");
    let heard = 0;
    store.subscribe(() => (heard += 1));
    expect(store.receive(snapshot(roomView([user(0)])))).toBe(true);
    const append = (seq: number): TargetFrame => ({
      type: "patch",
      target: "room:trip",
      seq,
      ops: [{ op: "append", path: ["timeline", 0, "text"], text: "!" }],
    });
    expect(store.receive(append(1))).toBe(true);
    expect(store.getState().view!.timeline[0]).toMatchObject({ text: "Message 0!" });

    expect(store.receive(append(3))).toBe(false);
    expect(store.getState()).toMatchObject({
      status: "syncing",
      view: { timeline: [{ text: "Message 0!" }] },
    });
    // Still the old subscription's patches: dropped until the snapshot.
    expect(store.receive(append(4))).toBe(true);
    expect(store.receive(snapshot(roomView([user(0)])))).toBe(true);
    expect(
      store.receive({
        type: "patch",
        target: "room:trip",
        seq: 1,
        ops: [{ op: "append", path: ["timeline", 5, "text"], text: "?" }],
      }),
    ).toBe(false);
    expect(store.getState().status).toBe("syncing");

    store.receive({ type: "unsubscribed", target: "room:trip", reason: "removed" });
    expect(store.getState()).toMatchObject({ status: "gone", reason: "removed" });
    expect(heard).toBe(6);
  });

  it("keep items that slide out of the view's window", () => {
    const store = new RoomStore("trip");
    store.receive(snapshot(roomView(users(0, 4))));
    store.receive({
      type: "patch",
      target: "room:trip",
      seq: 1,
      ops: [
        { op: "splice", path: ["timeline"], index: 0, remove: 2, insert: [] },
        { op: "splice", path: ["timeline"], index: 2, remove: 0, insert: users(4, 6) },
      ],
    });
    expect(store.getState().earlier.map((item) => item.id)).toEqual(["m0", "m1"]);
    expect(store.getState().timeline.map((item) => item.id)).toEqual(
      users(0, 6).map((item) => item.id),
    );
    // Reconnected, and the window moved on with a gap: the old items can't join, so they go.
    store.resync();
    store.receive(snapshot(roomView(users(10, 12))));
    expect(store.getState().earlier).toEqual([]);
  });

  it("slide joins overlapping windows and gives up on ones that don't overlap", () => {
    expect(slide([], users(0, 3), users(1, 4))).toEqual([user(0)]);
    expect(slide([user(0)], users(1, 3), users(1, 4))).toEqual([user(0)]);
    expect(slide([user(0)], users(1, 3), users(0, 4))).toEqual([]);
    expect(slide([], users(0, 3), users(5, 6))).toBeUndefined();
    expect(slide([user(0)], [], users(5, 6))).toEqual([user(0)]);
  });

  it("show pending messages until the timeline or the queue has them", () => {
    const store = new RoomStore("trip");
    store.receive(snapshot(roomView([], { hasEarlier: false })));
    store.sending({ requestId: "r1", text: "Hello" });
    store.sending({ requestId: "r2", text: "Again" });
    store.failed("r2", "Offline");
    expect(store.getState().pending).toEqual([
      { requestId: "r1", text: "Hello" },
      { requestId: "r2", text: "Again", error: "Offline" },
    ]);
    store.receive({
      type: "patch",
      target: "room:trip",
      seq: 1,
      ops: [
        {
          op: "set",
          path: ["queue"],
          value: [{ id: 1, mode: "followUp", text: "Hello", requestId: "r1", nudge: false }],
        },
      ],
    });
    expect(store.getState().pending.map((p) => p.requestId)).toEqual(["r2"]);
    store.dismiss("r2");
    expect(store.getState().pending).toEqual([]);
  });

  it("load earlier pages back to the start, without repeating slid items", async () => {
    const asked: (string | undefined)[] = [];
    const pages: Record<string, TimelineResponse> = {
      first: { items: users(1, 4), before: "c1" },
      c1: { items: users(0, 1) },
    };
    const store = new RoomStore("trip", async ({ before }) => {
      asked.push(before);
      return pages[before ?? "first"]!;
    });
    store.receive(snapshot(roomView(users(3, 6))));
    store.receive({
      type: "patch",
      target: "room:trip",
      seq: 1,
      ops: [{ op: "splice", path: ["timeline"], index: 0, remove: 1, insert: [] }],
    });
    expect(store.getState()).toMatchObject({ canLoadEarlier: true, earlier: [user(3)] });

    const loading = store.loadEarlier();
    expect(store.getState().loadingEarlier).toBe(true);
    await store.loadEarlier(); // Already loading: no second request.
    await loading;
    await store.loadEarlier();
    expect(asked).toEqual([undefined, "c1"]);
    expect(store.getState()).toMatchObject({ canLoadEarlier: false, loadingEarlier: false });
    expect(store.getState().timeline.map((item) => item.id)).toEqual(
      users(0, 6).map((item) => item.id),
    );
  });

  it("drop a page that arrives after the earlier items started over", async () => {
    let answer: (page: TimelineResponse) => void = () => {};
    const store = new RoomStore("trip", () => new Promise((resolve) => (answer = resolve)));
    store.receive(snapshot(roomView(users(5, 8))));
    const loading = store.loadEarlier();
    store.resync();
    store.receive(snapshot(roomView(users(20, 22))));
    answer({ items: users(0, 5), before: "c" });
    await loading;
    expect(store.getState()).toMatchObject({ earlier: [], loadingEarlier: false });
  });
});
