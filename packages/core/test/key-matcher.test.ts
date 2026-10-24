import { describe, expect, it } from "vitest";
import { KeyMatcher } from "../src/privacy/key-matcher.ts";

/** Keys and their patterns the way the vault makes them: boundaries, and a possessive `s` for some. */
function patternsOf(keys: readonly [string, boolean][]): { key: string; source: string }[] {
  return [...keys]
    .sort(([a], [b]) => b.length - a.length)
    .map(([key, possessive]) => {
      const word = /[\p{L}\p{N}_]/u;
      const body = key
        .split(" ")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+");
      const before = word.test(key[0] ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
      const after = !word.test(key.at(-1) ?? "")
        ? ""
        : possessive
          ? "(?=s?(?![\\p{L}\\p{N}_]))"
          : "(?![\\p{L}\\p{N}_])";
      return { key, source: before + body + after };
    });
}

const KEYS: [string, boolean][] = [
  ["ann", true],
  ["ann berg", true],
  ["berg", false],
  ["ola.nordmann@example.com", false],
  ["+47 912 34 567", false],
  ["σοφία", true],
  ["straße", false],
  ["i̇stanbul", true],
  ["kelvin", false],
  ["ﬅore", false],
  ["ΐa", false],
  ["😀 smile", false],
  ["c++", false],
];

const TEXTS = [
  "Ann Berg and ann  berg and ANN\n\tBERG met Anns friend at Bergen; Ann Bergen is not her.",
  "Mail OLA.NORDMANN@EXAMPLE.COM or call +47  912 34 567, not +479123 4567.",
  "ΣΟΦΊΑ, Σοφίας and σοφίαs; STRASSE and STRAẞE and straße.",
  "İstanbul i̇stanbul Istanbul ıstanbul; KELVIN Kelvin; ﬆore ﬅore; ΐa ΐa.",
  "😀 smile 😀  SMILE x😀 smile; C++ and c++x and xc++.",
  "Annberg _ann ann_ 1ann ann1 Anns' anns s",
  "",
];

describe("KeyMatcher", () => {
  it("matches what one alternation of the keys' patterns matches", () => {
    const keys = patternsOf(KEYS);
    const alternation = new RegExp(keys.map(({ source }) => source).join("|"), "giu");
    const matcher = new KeyMatcher(keys);
    for (const text of TEXTS) {
      const expected = text.replace(alternation, (match) => `[${match}]`);
      expect(matcher.replace(text, (match) => `[${match}]`)).toBe(expected);
    }
  });

  it("agrees with the alternation on random text made of the keys' pieces", () => {
    const keys = patternsOf(KEYS);
    const alternation = new RegExp(keys.map(({ source }) => source).join("|"), "giu");
    const matcher = new KeyMatcher(keys);
    const pieces = [
      ...KEYS.flatMap(([key]) => [key, key.toUpperCase(), key.slice(0, 3)]),
      ..." \n\t s _ 1 . , ' ı ß ẞ ς K 😀".split(" "),
    ];
    let state = 7;
    const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31);
    for (let n = 0; n < 2000; n++) {
      let text = "";
      for (let i = next() % 12; i > 0; i--) text += pieces[next() % pieces.length];
      const expected = text.replace(alternation, (match) => `[${match}]`);
      expect(matcher.replace(text, (match) => `[${match}]`)).toBe(expected);
    }
  });
});
