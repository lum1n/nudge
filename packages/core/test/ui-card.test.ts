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

  it("takes several choices and a number on a slider, and won't press a link", () => {
    const pick: UiCard = {
      v: 1,
      title: "Pizza",
      fields: [
        {
          name: "toppings",
          label: "Toppings",
          type: "choices",
          options: ["Ham", "Olives", "Corn"],
        },
        { name: "size", label: "Size", type: "range", min: 20, max: 40, step: 5 },
      ],
      buttons: [
        { id: "order", label: "Order" },
        { id: "menu", label: "Menu", url: "https://example.com/menu" },
      ],
    };
    expect(cardProblem(pick)).toBeUndefined();
    expect(pressText(pick, "order", { toppings: ["Ham", "Corn"], size: 30 })).toBe(
      'Pressed "Order" on "Pizza"\nToppings: Ham, Corn\nSize: 30',
    );
    // As an app that doesn't know the types yet sends them.
    expect(pressText(pick, "order", { toppings: "Ham, Olives", size: "25" })).toMatch(
      /Toppings: Ham, Olives\nSize: 25$/,
    );
    expect(() => pressText(pick, "order", { toppings: ["Fish"], size: 30 })).toThrow(/options/);
    expect(() => pressText(pick, "order", { toppings: [], size: 30 })).toThrow(/required/);
    expect(() => pressText(pick, "order", { toppings: ["Ham"], size: 50 })).toThrow(/20 to 40/);
    expect(() => pressText(pick, "menu")).toThrow(/opens a link/);
    expect(
      cardProblem({ ...pick, buttons: [{ id: "x", label: "x", url: "http://example.com" }] }),
    ).toMatch(/^\/buttons\/0\/url/);
    expect(
      cardProblem({ ...pick, fields: [{ name: "n", label: "N", type: "range", min: 5, max: 5 }] }),
    ).toMatch(/min at or above/);
  });

  it("checks events and diagrams", () => {
    const one = (block: object) => cardProblem({ v: 1, blocks: [block] } as UiCard);
    const event = { type: "event", title: "Dinner", start: "2026-11-03T18:00+01:00" };
    expect(one(event)).toBeUndefined();
    expect(one({ ...event, start: "2026-11-03", end: "2026-11-04" })).toBeUndefined();
    expect(one({ ...event, start: "2026-11-03T18:00" })).toMatch(/^\/blocks\/0/);
    expect(one({ ...event, end: "2026-11-03T17:00+01:00" })).toMatch(/ends before/);
    const nodes = [
      { id: "a", label: "Order" },
      { id: "b", label: "Pay" },
    ];
    expect(one({ type: "diagram", nodes, edges: [{ from: "a", to: "b" }] })).toBeUndefined();
    expect(one({ type: "diagram", nodes, edges: [{ from: "a", to: "c" }] })).toMatch(/isn't there/);
    expect(one({ type: "diagram", nodes: [nodes[0], nodes[0]] })).toMatch(/twice/);
  });
});
