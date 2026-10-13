import { describe, expect, it } from "vitest";
import { hideSecrets } from "../src/browser.ts";
import { compactSnapshot, findLines } from "../src/snapshot.ts";

const page = (body: string) => body.replace(/^\n/, "");

describe("compactSnapshot", () => {
  it("moves dialogs to the top, even when they sit at the end of the tree", () => {
    const raw = page(`
- generic [ref=e1]:
  - main [ref=e2]:
    - heading "Results" [level=1] [ref=e3]
    - button "Search" [ref=e4] [cursor=pointer]
  - dialog [ref=e9]:
    - iframe [ref=e10]:
      - heading "Cookies" [level=1] [ref=f1e2]
      - button "Reject all" [ref=f1e3] [cursor=pointer]`);
    const { text, dialogs } = compactSnapshot(raw);
    expect(dialogs).toBe(1);
    expect(text.indexOf("OPEN DIALOGS")).toBe(0);
    expect(text.indexOf('button "Reject all" [f1e3]')).toBeLessThan(
      text.indexOf('heading "Results"'),
    );
  });

  it("drops images and collapses runs of near-identical controls", () => {
    const dots = Array.from(
      { length: 15 },
      (_, i) => `      - button "Go to image ${i + 1}" [ref=e${20 + i}]`,
    ).join("\n");
    const imgs = Array.from({ length: 15 }, (_, i) => `      - img "Car ${i + 1} of 15"`).join(
      "\n",
    );
    const raw = page(`
- region "Car gallery" [ref=e1]:
  - generic [ref=e2]:
${imgs}
  - generic "Image navigation" [ref=e3]:
    - generic [ref=e4]:
${dots}`);
    const { text } = compactSnapshot(raw);
    expect(text).not.toContain("img");
    expect(text).toContain('button "Go to image 1" [e20]');
    expect(text).toContain("… 14 more like this");
    expect(compactSnapshot(raw).lines.join("\n")).toContain("Go to image 7");
    expect(text).not.toContain("Go to image 2");
  });

  it("renders a list of articles as one row each, with the first link", () => {
    const article = (n: number) => `
    - article [ref=e${n}0] [cursor=pointer]:
      - link [ref=e${n}1]:
        - /url: https://example.no/item/${n}
        - heading "Car ${n}" [level=2] [ref=e${n}2]
      - generic [ref=e${n}3]: 2027 ∙ 1 000 km
      - generic [ref=e${n}4]: ${n}00 000 kr
      - button "Add to favourites" [ref=e${n}5]`;
    const raw = page(`
- main [ref=e1]:
  - generic [ref=e2]:${article(1)}${article(2)}${article(3)}`);
    const { text } = compactSnapshot(raw);
    expect(text).toContain(
      "item: Car 1 · 2027 ∙ 1 000 km · 100 000 kr [e11] → https://example.no/item/1",
    );
    expect(text.match(/item:/g)).toHaveLength(3);
    expect(text).not.toContain("favourites");
  });

  it("treats a button wrapping the whole item as the item, not a side control", () => {
    const trip = (n: number) => `
  - listitem [ref=e${n}0]:
    - button "From Oslo S at 0${n}:34, arrives 0${n + 2}:41. Press for details" [ref=e${n}1] [cursor=pointer]:
      - heading "From Oslo S 2 hours" [level=2] [ref=e${n}2]
      - generic [ref=e${n}3]: RE10 Lillehammer
      - generic [ref=e${n}4]: 563 kr`;
    const raw = page(`
- list [ref=e1]:${trip(6)}${trip(7)}${trip(8)}`);
    const { text } = compactSnapshot(raw);
    expect(text).toContain(
      "item: From Oslo S at 07:34, arrives 09:41. Press for details · From Oslo S 2 hours · RE10 Lillehammer · 563 kr [e71]",
    );
  });

  it("keeps form controls inside list items reachable", () => {
    const raw = page(`
- list [ref=e1]:
  - listitem [ref=e2]:
    - textbox "Registration number" [ref=e3]
  - listitem [ref=e4]:
    - spinbutton "Mileage" [ref=e5]
  - listitem [ref=e6]:
    - button "Value my car" [ref=e7]`);
    const { text } = compactSnapshot(raw);
    expect(text).toContain('textbox "Registration number" [e3]');
    expect(text).toContain('spinbutton "Mileage" [e5]');
  });

  it("drops text that repeats a control's name but never a wrapper holding a control", () => {
    const raw = page(`
- generic "price_from" [ref=e1]:
  - generic "price_from" [ref=e2]:
    - spinbutton "Min" [ref=e3]
    - generic [ref=e4]: kr
  - generic [ref=e5]: Min,
  - status [ref=e6]
- checkbox "Oslo (36)" [ref=e7]
- generic [ref=e8] [cursor=pointer]:
  - generic [ref=e9]: Oslo
  - generic [ref=e10]: (36)`);
    const { text } = compactSnapshot(raw);
    expect(text).toContain('spinbutton "Min" [e3]');
    expect(text).not.toContain("Min,");
    expect(text).not.toContain("status");
    expect(text.match(/Oslo/g)).toHaveLength(1);
  });

  it("splits long pages and says how to read on", () => {
    const rows = Array.from(
      { length: 400 },
      (_, i) =>
        `- link "Result number ${i} with a long title" [ref=e${i}]:\n  - /url: https://example.no/${i}`,
    ).join("\n");
    const first = compactSnapshot(rows, { budget: 4_000 });
    expect(first.pages).toBeGreaterThan(1);
    expect(first.text.length).toBeLessThan(4_500);
    expect(first.text).toContain("browser_observe with page 2");
    const second = compactSnapshot(rows, { budget: 4_000, page: 2 });
    expect(second.text).not.toContain('"Result number 0 ');
  });
});

describe("findLines", () => {
  it("matches every word, case-insensitively", () => {
    const lines = [
      '- checkbox "Oslo (36)" [e1]',
      '- checkbox "Akershus (59)" [e2]',
      "- item: Car in Oslo sentrum · 300 000 kr [e3]",
    ];
    expect(findLines(lines, "oslo")).toHaveLength(2);
    expect(findLines(lines, "OSLO checkbox")).toEqual(['- checkbox "Oslo (36)" [e1]']);
  });
});

describe("hideSecrets", () => {
  it("hides what password and one-time-code fields hold, and nothing else", () => {
    const raw = [
      '- textbox "E-post" [ref=e4]: ola@example.no',
      '- textbox "Passord" [ref=e6]: Hemmelig123!',
      '- textbox "Engangskode" [active] [ref=e7]: "482913"',
      "- text: Hemmelig123! is not a field",
      '- textbox "Kort" [ref=e8]: 1',
    ].join("\n");
    expect(hideSecrets(raw, ["Hemmelig123!", "482913", "1"]).split("\n")).toEqual([
      '- textbox "E-post" [ref=e4]: ola@example.no',
      '- textbox "Passord" [ref=e6]: [hidden]',
      '- textbox "Engangskode" [active] [ref=e7]: [hidden]',
      "- text: Hemmelig123! is not a field",
      '- textbox "Kort" [ref=e8]: [hidden]',
    ]);
  });
});
