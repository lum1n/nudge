import type { RoomView } from "@nudge/client";
import { describe, expect, it } from "vitest";
import { ASLEEP_AFTER, ended, moodOf } from "../src/avatar/mood.ts";
import { blend, blink, MOODS, pose, REST } from "../src/avatar/pose.ts";

describe("pose", () => {
  it("gives the same pose for the same moment", () => {
    for (const mood of MOODS) expect(pose(mood, 12.34)).toEqual(pose(mood, 12.34));
  });

  it("stays in range in every mood, for a minute of frames", () => {
    // One expect at the end: tens of thousands of them made this slow enough to time out in CI.
    const outOfRange: string[] = [];
    for (const mood of MOODS) {
      for (let t = 0; t < 60; t += 1 / 30) {
        const p = pose(mood, t);
        const inRange =
          Object.values(p).every(Number.isFinite) &&
          Math.abs(p.gazeX) <= 1 &&
          Math.abs(p.gazeY) <= 1 &&
          p.eyeLeft >= 0 &&
          p.eyeLeft <= 1.35 &&
          p.sparks >= 0 &&
          p.sparks <= 1 &&
          p.cheeks <= 1;
        if (!inRange) outOfRange.push(`${mood} at ${t.toFixed(2)}s: ${JSON.stringify(p)}`);
      }
    }
    expect(outOfRange).toEqual([]);
  });

  it("blinks every few seconds, quickly", () => {
    let closed = 0;
    let blinks = 0;
    let shut = false;
    for (let t = 0; t < 60; t += 0.01) {
      const now = blink(t) > 0.9;
      if (now) closed += 0.01;
      if (now && !shut) blinks += 1;
      shut = now;
    }
    expect(blinks).toBeGreaterThan(10);
    expect(blinks).toBeLessThan(30);
    expect(closed).toBeLessThan(3);
  });

  it("follows the voice it is given", () => {
    const quiet = pose("speaking", 3, { level: 0 });
    const loud = pose("speaking", 3, { level: 1 });
    expect(loud.eyeLeft).toBeGreaterThan(quiet.eyeLeft);
    expect(loud.bob).toBeLessThan(quiet.bob);
  });

  it("blends field by field", () => {
    const happy = pose("happy", 1);
    expect(blend(REST, happy, 0)).toEqual(REST);
    expect(blend(REST, happy, 1)).toEqual(happy);
    expect(blend(REST, happy, 0.5).cheeks).toBeCloseTo(happy.cheeks / 2);
  });
});

const NOW = 1_800_000_000_000;

function view(over: Partial<Pick<RoomView, "timeline" | "live" | "approvals">> = {}) {
  return {
    timeline: [{ type: "user", id: "m1", text: "hi", sentAt: NOW - 1000 }],
    live: { running: false },
    approvals: [],
    ...over,
  } as Pick<RoomView, "timeline" | "live" | "approvals">;
}

function answer(parts: unknown[], status = "running") {
  return { type: "answer", id: "a1", status, parts, startedAt: NOW - 500 };
}

describe("moodOf", () => {
  it("is idle in a quiet room, and asleep in one quiet for long", () => {
    expect(moodOf(view(), NOW)).toBe("idle");
    expect(moodOf(view(), NOW + ASLEEP_AFTER + 1000)).toBe("asleep");
    // A room with no times at all is new, not sleepy.
    expect(moodOf(view({ timeline: [] }), NOW)).toBe("idle");
  });

  it("thinks, works and speaks while the turn runs", () => {
    const running = (parts: unknown[]) =>
      view({ live: { running: true }, timeline: [answer(parts)] as RoomView["timeline"] });
    expect(moodOf(running([]), NOW)).toBe("thinking");
    expect(moodOf(running([{ type: "reasoning", text: "hm" }]), NOW)).toBe("thinking");
    expect(
      moodOf(
        running([{ type: "tool", callId: "c", name: "browser", args: {}, status: "running" }]),
        NOW,
      ),
    ).toBe("working");
    expect(moodOf(running([{ type: "text", text: "Here" }]), NOW)).toBe("speaking");
  });

  it("waits on an approval and is puzzled while retrying, before anything else", () => {
    const approvals = [{ status: "pending" }] as RoomView["approvals"];
    expect(moodOf(view({ approvals, live: { running: true } }), NOW)).toBe("waiting");
    const retrying = {
      running: true,
      status: { kind: "retrying", attempt: 2, at: NOW, error: "529" },
    } as const;
    expect(moodOf(view({ live: retrying }), NOW)).toBe("puzzled");
    expect(moodOf(view({ approvals }), NOW, { listening: true })).toBe("listening");
  });

  it("ends a turn happy or sad", () => {
    expect(ended("done")).toBe("happy");
    expect(ended("failed")).toBe("sad");
    expect(ended("stopped")).toBeUndefined();
  });
});
