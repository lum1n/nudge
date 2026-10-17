import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { apply, RoomListView, RoomView, ServerFrame } from "../src/index.ts";

/**
 * What Ann's socket received in a recorded run of room "trip" and her room list, one `{ frame, view }`
 * per line. The server's `v1-stream.test.ts` records it again with `NUDGE_RECORD=1`.
 */
async function recording(): Promise<{ frame: ServerFrame; view?: unknown }[]> {
  const text = await readFile(new URL("./fixtures/room-stream.jsonl", import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { frame: ServerFrame; view?: unknown });
}

describe("recorded stream", () => {
  it("is protocol v1, and its patches rebuild every recorded view", async () => {
    const lines = await recording();
    expect(lines[0]?.frame.type).toBe("welcome");
    const views = new Map<string, unknown>();
    const seqs = new Map<string, number>();
    for (const { frame, view } of lines) {
      expect(Value.Check(ServerFrame, frame)).toBe(true);
      if (frame.type === "snapshot") {
        views.set(frame.target, frame.view);
        expect(frame.seq).toBe(0);
        seqs.set(frame.target, 0);
      } else if (frame.type === "patch") {
        expect(frame.seq).toBe(seqs.get(frame.target)! + 1);
        seqs.set(frame.target, frame.seq);
        views.set(frame.target, apply(views.get(frame.target), frame.ops));
      } else continue;
      expect(views.get(frame.target)).toEqual(view);
      expect(Value.Check(frame.target === "rooms" ? RoomListView : RoomView, view)).toBe(true);
    }
    expect([...seqs.keys()].sort()).toEqual(["room:trip", "rooms"]);
  });
});
