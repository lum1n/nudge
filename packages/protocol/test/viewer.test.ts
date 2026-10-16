import type { RoomView } from "@nudge/protocol";
import { describe, expect, it } from "vitest";
import { Viewer } from "../src/viewer.ts";

const ann = { id: "ann", displayName: "Ann" };

function room(): RoomView {
  return {
    room: { id: "trip", kind: "shared", name: "Trip", members: [ann] },
    timeline: [
      {
        type: "user",
        id: "entry:1",
        text: "secret X",
        author: ann,
        privateTo: ann,
        clientId: "c1",
      },
      {
        type: "answer",
        id: "answer:entry:1",
        status: "done",
        parts: [{ type: "text", text: "ok X" }],
        privateTo: ann,
      },
      { type: "user", id: "entry:3", text: "public X", author: ann },
      { type: "marker", id: "entry:4", kind: "compacted" },
    ],
    hasEarlier: false,
    live: { running: false },
    queue: [
      { id: 1, mode: "followUp", text: "later X", author: ann, nudge: false, privateTo: ann },
    ],
    approvals: [{ id: "a1", summary: "pay X", status: "pending", requestedAt: 1, privateTo: ann }],
    memory: [
      { id: "m1", text: "fact X", createdAt: 1, privateTo: ann },
      { id: "m2", text: "open X", createdAt: 1 },
    ],
    nudges: [{ id: "7", message: "nudge X", fireAt: 1, privateTo: ann }],
  };
}

describe("Viewer", () => {
  const show = (who: string) => (text: string) => text.replaceAll("X", who);

  it("empties what is private to others and shows the rest through `show`", () => {
    const bo = new Viewer("bo", show("bo")).room(room());
    expect(bo.timeline).toEqual([
      { type: "user", id: "entry:1", text: "", author: ann, privateTo: ann },
      { type: "answer", id: "answer:entry:1", status: "done", parts: [], privateTo: ann },
      { type: "user", id: "entry:3", text: "public bo", author: ann },
      { type: "marker", id: "entry:4", kind: "compacted" },
    ]);
    expect(bo.queue).toEqual([
      { id: 1, mode: "followUp", text: "", author: ann, nudge: false, privateTo: ann },
    ]);
    expect(bo.approvals).toEqual([]);
    expect(bo.memory).toEqual([{ id: "m2", text: "open bo", createdAt: 1 }]);
    expect(bo.nudges).toEqual([]);

    const own = new Viewer("ann", show("ann")).room(room());
    expect(own.timeline[0]).toMatchObject({ text: "secret ann", clientId: "c1" });
    expect(own.timeline[1]).toMatchObject({ parts: [{ type: "text", text: "ok ann" }] });
    expect(own.approvals).toHaveLength(1);
    expect(own.memory).toHaveLength(2);
  });

  it("keeps unchanged parts as the same objects until `show` may change", () => {
    let version = 0;
    const viewer = new Viewer("bo", show("bo"), () => version);
    const view = room();
    const first = viewer.room(view);
    const next = viewer.room({ ...view, live: { running: true } });
    expect(next.timeline[2]).toBe(first.timeline[2]);
    expect(next.memory).toBe(first.memory);
    version++;
    expect(viewer.room({ ...view }).timeline[2]).not.toBe(first.timeline[2]);
  });
});
