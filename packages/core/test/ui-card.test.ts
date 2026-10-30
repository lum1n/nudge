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
});
