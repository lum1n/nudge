import { describe, expect, it } from "vitest";
import { keyInput } from "../src/live-view.ts";

const key = (
  key: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) => keyInput({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("keyInput", () => {
  it("sends characters as text and named keys by name", () => {
    expect(key("a")).toEqual({ type: "text", text: "a" });
    expect(key("ø")).toEqual({ type: "text", text: "ø" });
    expect(key(" ")).toEqual({ type: "text", text: " " });
    expect(key("Enter")).toEqual({ type: "key", key: "Enter" });
    expect(key("Backspace")).toEqual({ type: "key", key: "Backspace" });
  });

  it("sends chords in Playwright's form and ignores keys it does not know", () => {
    expect(key("a", { ctrlKey: true })).toEqual({ type: "key", key: "Control+A" });
    expect(key("v", { metaKey: true })).toEqual({ type: "key", key: "Meta+V" });
    expect(key("Shift")).toBeUndefined();
    expect(key("F5")).toBeUndefined();
    expect(key("Enter", { ctrlKey: true })).toBeUndefined();
  });
});
