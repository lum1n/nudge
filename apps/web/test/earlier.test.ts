import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { applyTranscriptPage, NO_HISTORY } from "../src/earlier.ts";

const entry = (id: number): EntryRecord =>
  ({ id, conversationId: 1, kind: "pi.user", model: [] }) as unknown as EntryRecord;

describe("applyTranscriptPage", () => {
  it("prepends a newer-first page's new entries, oldest first, before what was already loaded", () => {
    const first = applyTranscriptPage(
      NO_HISTORY,
      { entries: [entry(6), entry(5)], next: "cursor-1" },
      new Set(),
    );
    expect(first.entries.map((e) => e.id)).toEqual([5, 6]);
    expect(first.cursor).toBe("cursor-1");
    expect(first.hasMore).toBe(true);

    const second = applyTranscriptPage(
      first,
      { entries: [entry(4), entry(3)] },
      new Set(["5", "6"]),
    );
    expect(second.entries.map((e) => e.id)).toEqual([3, 4, 5, 6]);
    expect(second.cursor).toBeUndefined();
    expect(second.hasMore).toBe(false);
  });

  it("drops entries already known, e.g. ones the live view already shows", () => {
    const result = applyTranscriptPage(
      NO_HISTORY,
      { entries: [entry(6), entry(5)], next: "cursor-1" },
      new Set(["5", "6"]),
    );
    expect(result.entries).toEqual([]);
    // The cursor still advances: the caller fetches the next page to look further back.
    expect(result.cursor).toBe("cursor-1");
    expect(result.hasMore).toBe(true);
  });
});
