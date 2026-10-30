import { cardProblem } from "@nudge/core";
import { describe, expect, it } from "vitest";
import { type SessionRow, sessionsCard } from "../src/card.ts";

const row = (id: string, status: SessionRow["status"], idleMinutes?: number): SessionRow => ({
  host: "devbox",
  id,
  harness: "claude",
  status,
  ...(idleMinutes === undefined ? {} : { idleMinutes }),
});

describe("sessionsCard", () => {
  it("shows sessions as a timeline with the running ones current", () => {
    const card = sessionsCard([row("s1", "running", 2), row("s2", "exited", 130)]);
    expect(cardProblem(card)).toBeUndefined();
    const timeline = card?.blocks?.find((block) => block.type === "timeline");
    expect(timeline).toMatchObject({
      items: [
        { time: "2 min ago", state: "current" },
        { time: "2 h ago", state: "done" },
      ],
    });
  });

  it("has no card without sessions, and stays valid with many", () => {
    expect(sessionsCard([])).toBeUndefined();
    const many = Array.from({ length: 40 }, (_, i) => row(`s${i}`, "exited", i));
    expect(cardProblem(sessionsCard(many))).toBeUndefined();
  });
});
