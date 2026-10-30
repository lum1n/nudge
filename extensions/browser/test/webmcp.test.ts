import { describe, expect, it } from "vitest";
import type { Approval } from "../src/gate.ts";
import { progressLine, runBatch } from "../src/tools.ts";
import { describePageTools, type PageTool, pinPageTool } from "../src/webmcp.ts";
import { fakeBrowser } from "./fake-browser.ts";

const TOOLS: PageTool[] = [
  {
    name: "search",
    description: "Search products",
    inputSchema: { type: "object" },
    readOnly: true,
  },
  { name: "order", description: "Order a product", readOnly: false },
];

describe("page tools (WebMCP)", () => {
  it("describes a page's tools, and says when there are none", () => {
    const text = describePageTools("shop.no", TOOLS);
    expect(text).toContain("shop.no offers 2 tools of its own");
    expect(text).toContain('- search (reads): Search products\n  input: {"type":"object"}');
    expect(text).toContain(
      "- order (may change things: needs the user's approval): Order a product",
    );
    expect(describePageTools("shop.no", [])).toBe(
      "shop.no offers no tools of its own (WebMCP). Use the page as usual.",
    );
  });

  it("pins a call to its arguments, whatever their key order", () => {
    expect(pinPageTool("shop.no", "order", { a: 1, b: [2, { c: 3, d: 4 }] })).toEqual(
      pinPageTool("shop.no", "order", { b: [2, { d: 4, c: 3 }], a: 1 }),
    );
    expect(pinPageTool("shop.no", "order", { a: 1 })).not.toEqual(
      pinPageTool("shop.no", "order", { a: 2 }),
    );
  });

  it("calls a read-only tool at once and holds one that changes things until it is approved", async () => {
    const { browser, calls } = fakeBrowser(undefined, {}, TOOLS);
    const [read] = await runBatch(browser, [
      {
        id: "1",
        name: "browser_call_page_tool",
        arguments: { name: "search", arguments: { q: "milk" } },
      },
    ]);
    expect(read!.text.split("\n")[0]).toBe("search done.");

    const order = { name: "order", arguments: { product: "milk" } };
    const approval: Approval = {};
    const [held] = await runBatch(
      browser,
      [{ id: "2", name: "browser_call_page_tool", arguments: order }],
      undefined,
      approval,
    );
    expect(held!.isError).toBe(true);
    expect(calls).toEqual(['page tool search {"q":"milk"}']);

    const [asked] = await runBatch(
      browser,
      [
        {
          id: "3",
          name: "browser_confirm",
          arguments: {
            action: "Order milk",
            tool: "browser_call_page_tool",
            pageTool: "order",
            arguments: order.arguments,
          },
        },
      ],
      undefined,
      approval,
    );
    expect(asked!.ends).toBe("needs-confirmation");
    const approved: Approval = { approved: approval.asked! };
    await runBatch(
      browser,
      [{ id: "4", name: "browser_call_page_tool", arguments: order }],
      undefined,
      approved,
    );
    // Used up: the same call again needs another approval.
    const [again] = await runBatch(
      browser,
      [{ id: "5", name: "browser_call_page_tool", arguments: order }],
      undefined,
      approved,
    );
    expect(again!.isError).toBe(true);
    expect(calls.at(-1)).toBe('page tool order {"product":"milk"}');
    expect(calls.filter((call) => call.startsWith("page tool order"))).toHaveLength(1);
  });

  it("says which tools a page has when the model names another", async () => {
    const { browser } = fakeBrowser(undefined, {}, TOOLS);
    const [missing] = await runBatch(browser, [
      { id: "1", name: "browser_call_page_tool", arguments: { name: "pay" } },
    ]);
    expect(missing!.text).toMatch(/^The page has no tool "pay". It has: search, order\./);
    expect(
      progressLine(browser, { name: "browser_call_page_tool", arguments: { name: "search" } }),
    ).toBe('Using the page\'s "search" tool…');
  });
});
