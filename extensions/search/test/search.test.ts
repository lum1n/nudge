import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageText, searchExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
/** A public address as a literal, so checking it needs no DNS. */
const SITE = "http://93.184.215.14";

describe("search", () => {
  let nudge: Nudge;
  let requests: ModelContext[];
  let asked: string[];
  let next: [string, Parameters<typeof fauxToolCall>[1]] | undefined;

  const web: typeof fetch = async (input) => {
    const url = new URL(String(input));
    asked.push(url.href);
    if (url.pathname === "/search") {
      if (url.searchParams.get("format") !== "json") return new Response("", { status: 403 });
      return Response.json({
        results: [
          {
            title: "Kiwi Storgata — opening hours",
            url: `${SITE}/kiwi`,
            content: "Open 07–23   on weekdays.",
            publishedDate: "2026-10-01T00:00:00",
          },
          { title: "No address" },
        ],
      });
    }
    if (url.pathname === "/kiwi")
      return new Response(
        "<html><head><title>Kiwi &amp; co</title><style>x{}</style></head><body><h1>Kiwi</h1><p>Weekdays 07–23</p><ul><li>Sunday closed</li></ul><script>track()</script></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    if (url.pathname === "/moved")
      return new Response(null, { status: 301, headers: { location: "/kiwi" } });
    if (url.pathname === "/inside")
      return new Response(null, { status: 302, headers: { location: "http://192.168.1.1/admin" } });
    return new Response("not found", { status: 404 });
  };

  beforeEach(async () => {
    requests = [];
    asked = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      requests.push(request);
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult" || next === undefined)
        return fauxAssistantMessage([fauxText("Done.")]);
      const call = next;
      next = undefined;
      return fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 50 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: searchExtension({ fetch: web }),
            settings: { url: "http://searx.local:8888/", language: "nb" },
          },
        ],
      },
      context,
    );
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  const call = async (tool: string, args: Parameters<typeof fauxToolCall>[1]) => {
    next = [tool, args];
    const author = { playerId: "owner", displayName: "Vegard" };
    await (await nudge.submit(LOBBY, { text: "go", author }, context)).wait(context);
    const last = requests.at(-1)!.messages.findLast((m) => m.role === "toolResult");
    return last?.role === "toolResult"
      ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : "";
  };

  it("searches through SearXNG's JSON and reads a result as text", async () => {
    expect(
      await call("web_search", { query: "kiwi storgata åpningstider", time_range: "month" }),
    ).toBe(
      [
        "1. Kiwi Storgata — opening hours",
        // The site's address is hidden from the model like any other.
        `   ${SITE.replace(/\d+(?:\.\d+){3}/, "⟦IP1⟧")}/kiwi`,
        "   2026-10-01",
        "   Open 07–23 on weekdays.",
      ].join("\n"),
    );
    const search = new URL(asked[0]!);
    expect(search.origin + search.pathname).toBe("http://searx.local:8888/search");
    expect(Object.fromEntries(search.searchParams)).toEqual({
      q: "kiwi storgata åpningstider",
      format: "json",
      language: "nb",
      time_range: "month",
    });

    expect(await call("read_page", { url: `${SITE}/moved` })).toBe(
      `Kiwi & co (${SITE.replace(/\d+(?:\.\d+){3}/, "⟦IP1⟧")}/kiwi), characters 0–35 of 35:\n\nKiwi\nWeekdays 07–23\n- Sunday closed`,
    );
  });

  it("keeps read_page off local addresses, also through a redirect", async () => {
    expect(await call("read_page", { url: "http://127.0.0.1:8787/v1" })).toMatch(
      /127\.0\.0\.1 is a local address/,
    );
    expect(await call("read_page", { url: `${SITE}/inside` })).toMatch(/⟦IP\d⟧ is a local address/);
    expect(asked).toEqual([`${SITE}/inside`]);
    expect(await call("read_page", { url: "file:///etc/passwd" })).toBe(
      "Only http and https pages are read, not file:",
    );
  });

  it("turns HTML into readable text", () => {
    expect(
      pageText("<p>A&#39;s <b>b</b></p><!-- x --><div>Bl&aring;b&aelig;r &#x2013; c</div>").text,
    ).toBe("A's b\nBlåbær – c");
  });
});
