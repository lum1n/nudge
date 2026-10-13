import { decoder, encoder } from "@earendil-works/chord/delta";
import { describe, expect, it } from "vitest";
import { ViewMirror } from "../src/mirror.ts";
import { frames, replay } from "./replay.ts";

describe("ViewMirror", () => {
  it("follows the stream, sharing what a frame did not change", () => {
    const views = replay();
    const last = views.at(-1)!;
    expect(last.entries.map((entry) => entry.kind)).toContain("nudge.fire");
    expect(last.docs["pi.live"]).toEqual({});

    // A frame that only moves `pi.live` leaves the transcript as it was.
    const index = views.findIndex(
      (view, i) => i > 0 && view.entries === views[i - 1]!.entries && view !== views[i - 1],
    );
    expect(index).toBeGreaterThan(0);
    expect(views[index]!.docs["pi.inbox"]).toBe(views[index - 1]!.docs["pi.inbox"]);
  });

  it("starts over with a fresh decoder when a new view arrives", () => {
    const views = replay();
    const half = Math.floor(frames.length / 2);
    const mirror = new ViewMirror();
    for (const frame of frames.slice(0, half)) mirror.receive(frame);

    // A reconnect: the new socket's encoder interns paths from scratch.
    mirror.receive({ type: "view", value: views[half - 1]! });
    const read = decoder();
    const write = encoder();
    for (const frame of frames.slice(1, half)) read.decode(frame.type === "ops" ? frame.ops : []);
    for (const frame of frames.slice(half))
      if (frame.type === "ops")
        mirror.receive({ type: "ops", ops: write.encode(read.decode(frame.ops)) });
    expect(mirror.value).toEqual(views.at(-1));
  });

  it("refuses ops before a view, and ignores other frames", () => {
    const mirror = new ViewMirror();
    expect(() => mirror.receive({ type: "ops", ops: [] })).toThrow();
    expect(mirror.receive({ type: "submitted", submissionId: 1 })).toBe(false);
  });
});
