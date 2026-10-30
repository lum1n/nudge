import { describe, expect, it } from "vitest";
import { cardOf, cardProblem, pressText, type UiCard, UiPressInvalid } from "../src/ui/card.ts";

const card: UiCard = {
  v: 1,
  title: "Trip",
  fields: [
    { name: "who", label: "Who", type: "choice", options: ["Ann", "Bo"] },
    { name: "kids", label: "Kids", type: "boolean", optional: true },
    { name: "note", label: "Note", type: "text", multiline: true, optional: true },
  ],
  buttons: [
    { id: "go", label: "Go" },
    { id: "cancel", label: "Cancel", skipsFields: true },
  ],
};

describe("cards", () => {
  it("checks a card", () => {
    expect(cardProblem(card)).toBeUndefined();
    expect(cardProblem({ v: 1 })).toBe("A card needs a title or a block");
    expect(cardProblem({ v: 2, title: "x" })).toMatch(/^\/v: /);
    expect(cardProblem({ ...card, buttons: [card.buttons![0], card.buttons![0]] })).toMatch(
      /twice/,
    );
    expect(
      cardProblem({
        v: 1,
        title: "x",
        blocks: [{ type: "image", attachment: "https://x/y.png", alt: "" }],
      }),
    ).toMatch(/^\/blocks\/0/);
    expect(cardOf({ ui: card })).toBe(card);
    expect(cardOf({ ui: { v: 1, title: 3 } })).toBeUndefined();
    expect(cardOf(undefined)).toBeUndefined();
  });

  it("says what a press chose, and refuses one the card doesn't allow", () => {
    expect(pressText(card, "go", { who: "Bo", kids: true, note: "a\nb" })).toBe(
      'Pressed "Go" on "Trip"\nWho: Bo\nKids: yes\nNote: \na\nb',
    );
    expect(pressText(card, "cancel", { who: "nobody" })).toBe('Pressed "Cancel" on "Trip"');
    expect(() => pressText(card, "go", {})).toThrow(UiPressInvalid);
    expect(() => pressText(card, "go", { who: "Cy" })).toThrow(/one of its options/);
    expect(() => pressText(card, "go", { who: "Ann", kids: "yes" })).toThrow(/yes or no/);
    expect(() => pressText(card, "go", { who: "Ann", extra: 1 })).toThrow(/No field "extra"/);
    expect(() => pressText(card, "stop")).toThrow(/No button "stop"/);
  });

  it("checks what the schema can't say about maps and charts", () => {
    const one = (block: object) => cardProblem({ v: 1, blocks: [block] } as UiCard);
    expect(
      one({ type: "map", markers: [{ lat: 59.9, lon: 10.7, label: "Oslo" }] }),
    ).toBeUndefined();
    expect(one({ type: "map" })).toMatch(/markers or a path/);
    expect(one({ type: "map", markers: [{ lat: 91, lon: 0, label: "x" }] })).toMatch(
      /^\/blocks\/0/,
    );
    const chart = { type: "chart", kind: "bar", labels: ["Jan", "Feb"] };
    expect(one({ ...chart, series: [{ name: "kr", values: [1, null] }] })).toBeUndefined();
    expect(one({ ...chart, series: [{ name: "kr", values: [1] }] })).toMatch(/1 values for 2/);
    expect(
      one({
        ...chart,
        kind: "pie",
        series: [
          { name: "a", values: [1, 2] },
          { name: "b", values: [1, 2] },
        ],
      }),
    ).toMatch(/one series/);
    expect(one({ ...chart, kind: "pie", series: [{ name: "a", values: [1, -2] }] })).toMatch(
      /negative/,
    );
    expect(
      one({ type: "stats", items: [{ label: "Spent", value: "4 200 kr", tone: "bad" }] }),
    ).toBeUndefined();
    expect(one({ type: "progress", items: [{ label: "Saved", value: 3, max: 0 }] })).toMatch(
      /^\/blocks\/0/,
    );
  });

  it("takes days and times as they are sent", () => {
    const when: UiCard = {
      v: 1,
      title: "When",
      fields: [
        { name: "day", label: "Day", type: "date" },
        { name: "at", label: "At", type: "time" },
      ],
      buttons: [{ id: "ok", label: "OK" }],
    };
    expect(pressText(when, "ok", { day: "2026-11-02", at: "18:30" })).toBe(
      'Pressed "OK" on "When"\nDay: 2026-11-02\nAt: 18:30',
    );
    expect(() => pressText(when, "ok", { day: "2026-02-30", at: "18:30" })).toThrow(/a day/);
    expect(() => pressText(when, "ok", { day: "2026-11-02", at: "24:00" })).toThrow(/a time/);
  });
});
