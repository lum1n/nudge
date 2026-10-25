import { describe, expect, it } from "vitest";
import { allowDictation, dictationAllowed, speechLanguage } from "../src/dictation.ts";
import { dollars, monthLabel, shareOf, spendRows } from "../src/spend.ts";

describe("spend", () => {
  it("shows dollars, and that a tiny spend was one", () => {
    expect(dollars(0)).toBe(dollars(0.0));
    expect(dollars(0.001)).toMatch(/^< /);
    expect(dollars(12.5)).toContain("12.50");
  });

  it("names months, and leaves what isn't one alone", () => {
    expect(monthLabel("2026-10")).toMatch(/2026/);
    expect(monthLabel("someday")).toBe("someday");
  });

  it("lists spend most first, by name where known", () => {
    const names = new Map([["ann", "Ann"]]);
    expect(spendRows({ bob: 1, ann: 3, zed: 0 }, names)).toEqual([
      { id: "ann", name: "Ann", usd: 3 },
      { id: "bob", name: "bob", usd: 1 },
    ]);
  });

  it("measures spend against a limit", () => {
    expect(shareOf(5, 10)).toBe(0.5);
    expect(shareOf(15, 10)).toBe(1);
    expect(shareOf(5, undefined)).toBeUndefined();
  });
});

describe("dictation", () => {
  it("listens in the profile's language, else the browser's", () => {
    expect(speechLanguage("nb-no", "en-US")).toBe("nb-NO");
    expect(speechLanguage(" de ", "en-US")).toBe("de");
    expect(speechLanguage("Norwegian bokmål", "en-US")).toBe("en-US");
    expect(speechLanguage(undefined, "en-US")).toBe("en-US");
  });

  it("remembers that the player agreed", () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    };
    expect(dictationAllowed(storage)).toBe(false);
    allowDictation(storage);
    expect(dictationAllowed(storage)).toBe(true);
  });
});
