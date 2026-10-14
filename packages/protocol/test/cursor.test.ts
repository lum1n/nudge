import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/index.ts";

describe("cursors", () => {
  it("round-trip JSON, including text outside ASCII, as URL-safe text", () => {
    const value = { before: 1234, conversation: 7, note: "blåbær 🫐" };
    const cursor = encodeCursor(value);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(value);
  });

  it("reads anything else as no cursor", () => {
    expect(decodeCursor("not a cursor!")).toBeUndefined();
    expect(decodeCursor(btoa("{oops"))).toBeUndefined();
  });
});
