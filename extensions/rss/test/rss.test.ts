import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge, untrustedData } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFeed, parseFeed, rssExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
/** A public address as a literal, so checking it needs no DNS. */
const SITE = "http://93.184.215.14";

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Byavisa</title><link>${SITE}/</link>
<item><title>Ferja går igjen</title><link>${SITE}/ferja</link>
<pubDate>Tue, 20 Oct 2026 06:00:00 GMT</pubDate>
<description>&lt;p&gt;Ruta er &lt;b&gt;tilbake&lt;/b&gt; &amp;amp; i rute.&lt;/p&gt;</description></item>
<item><title><![CDATA[Ny bru åpnet]]></title><link>${SITE}/bru</link>
<pubDate>Wed, 21 Oct 2026 07:30:00 GMT</pubDate>
<description><![CDATA[<p>Brua er åpen for trafikk.</p>]]></description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Været</title>
<link rel="self" href="${SITE}/atom"/>
<entry><title type="html">Storm på vei</title>
<link rel="alternate" href="${SITE}/storm"/><updated>2026-10-21T05:00:00Z</updated>
<summary>Sterk vind i kveld.</summary></entry>
</feed>`;

describe("rss", () => {
  let nudge: Nudge;
  let requests: ModelContext[];
  let asked: string[];
  let next: [string, Parameters<typeof fauxToolCall>[1]] | undefined;

  const web: typeof fetch = async (input) => {
    const url = new URL(String(input));
    asked.push(url.href);
    const xml = (body: string) =>
      new Response(body, { headers: { "content-type": "application/rss+xml" } });
    if (url.pathname === "/rss") return xml(RSS);
    if (url.pathname === "/atom") return xml(ATOM);
    if (url.pathname === "/")
      return new Response(
        `<html><head><link rel="alternate" type="application/atom+xml" href="/atom"></head></html>`,
        { headers: { "content-type": "text/html" } },
      );
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
        timeZone: "UTC",
        extensions: [
          {
            extension: rssExtension({ fetch: web }),
            settings: { feeds: [{ name: "Byavisa", url: `${SITE}/rss`, rooms: ["*"] }] },
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

  it("tells the model to check its feeds first for news", async () => {
    await call("list_feeds", {});
    expect(JSON.stringify(requests[0]!.messages.filter((m) => m.role === "system"))).toContain(
      "news feeds: Byavisa. When asked for the latest news, or anything these feeds cover, read them with read_feeds first",
    );
  });

  it("adds a site's feed and reads every feed newest first", async () => {
    expect(await call("add_feed", { url: `${SITE}/` })).toBe(
      `Added feed f1: Været (${SITE}/atom), with 1 stories now.`,
    );
    expect(asked).toEqual([`${SITE}/`, `${SITE}/atom`]);
    expect(await call("add_feed", { url: `${SITE}/rss` })).toMatch(/has that feed already: s1/);

    // Stories are written elsewhere: the model gets them as untrusted data.
    expect(await call("read_feeds", {})).toBe(
      untrustedData(
        "read_feeds",
        [
          "1. Ny bru åpnet",
          "   Byavisa, 2026-10-21 07:30",
          `   ${SITE}/bru`,
          "   Brua er åpen for trafikk.",
          "2. Storm på vei",
          "   Været, 2026-10-21 05:00",
          `   ${SITE}/storm`,
          "   Sterk vind i kveld.",
          "3. Ferja går igjen",
          "   Byavisa, 2026-10-20 06:00",
          `   ${SITE}/ferja`,
          "   Ruta er tilbake & i rute.",
        ].join("\n"),
      ),
    );
    expect(await call("read_feeds", { query: "STORM" })).toMatch(
      /^<untrusted-data source="read_feeds">\n1\. Storm på vei\n[^\n]*\n[^\n]*\n[^\n]*\n<\/untrusted-data>$/,
    );
    expect(await call("read_feeds", { feed: "byavisa", max_items: 1 })).toMatch(
      /^<untrusted-data source="read_feeds">\n1\. Ny bru åpnet/,
    );

    expect(await call("remove_feed", { feed: "s1" })).toMatch(/in the assistant's settings/);
    expect(await call("remove_feed", { feed: "Været" })).toBe(
      `Removed feed f1: Været (${SITE}/atom).`,
    );
    expect(await call("list_feeds", {})).toBe(`s1: Byavisa (${SITE}/rss)`);
  });

  it("keeps feeds off local addresses", async () => {
    expect(await call("add_feed", { url: "http://192.168.1.1/rss" })).toMatch(
      /is a local address: only public feeds are read/,
    );
    expect(asked).toEqual([]);
  });

  it("parses RSS and Atom, and finds a page's feed", () => {
    expect(parseFeed(ATOM)).toEqual({
      title: "Været",
      items: [
        {
          title: "Storm på vei",
          link: `${SITE}/storm`,
          published: Date.parse("2026-10-21T05:00:00Z"),
          summary: "Sterk vind i kveld.",
        },
      ],
    });
    expect(parseFeed(RSS).items.map((item) => item.summary)).toEqual([
      "Ruta er tilbake & i rute.",
      "Brua er åpen for trafikk.",
    ]);
    expect(() => parseFeed("<html></html>")).toThrow(/not an RSS or Atom feed/);
    expect(
      discoverFeed(
        `<link type="application/rss+xml" rel="alternate" href="/feed?a=1&amp;b=2">`,
        SITE,
      ),
    ).toBe(`${SITE}/feed?a=1&b=2`);
  });
});
