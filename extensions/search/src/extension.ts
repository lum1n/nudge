import { defineNudgeExtension, defineTool, readsOnly, section, Type } from "@nudge/core";
import { assertReachable } from "@nudge/ext-connectors";

const VERSION = "0.1.0";
/** Characters of a page `read_page` gives at a time. */
const CHUNK = 8_000;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;

const Settings = Type.Object({
  /** The SearXNG instance, with JSON output turned on (`search.formats: [html, json]`). */
  url: Type.String({
    default: "http://127.0.0.1:8888",
    pattern: "^https?://",
    title: "SearXNG URL",
    description:
      "The address of your SearXNG instance, with JSON output turned on in its settings.yml.",
  }),
  /** A language code such as `nb` or `en`, or `auto`. */
  language: Type.String({
    default: "auto",
    description: "The language to search in, as a code such as nb or en, or auto.",
  }),
  maxResults: Type.Number({
    default: 8,
    minimum: 1,
    maximum: 30,
    description: "Most results one search gives the assistant.",
  }),
  /** Let `read_page` reach local addresses too; off, so a page can't lead it into the house. */
  readLocalPages: Type.Boolean({
    default: false,
    description:
      "Let page reading reach localhost and your local network; off, so a web page can't lead it inside.",
  }),
});

type SearxResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  publishedDate?: string | null;
};

export class SearchError extends Error {
  override name = "SearchError";
}

/** One page's text: tags out, line breaks at block ends, entities decoded. */
export function pageText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|header|footer|tr|li|h\d|table|ul|ol|blockquote|pre)>/gi,
      "\n",
    )
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[\da-f]+|[a-z]+);/gi, entity)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: decode(title), text };
}

function decode(text: string): string {
  return text.replace(/&(#x?[\da-f]+|[a-z]+);/gi, entity);
}

/** Entities pages use most, Norwegian letters among them; others stay as they are. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  euro: "€",
  copy: "©",
  deg: "°",
  aelig: "æ",
  oslash: "ø",
  aring: "å",
  AElig: "Æ",
  Oslash: "Ø",
  Aring: "Å",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  eacute: "é",
};

function entity(whole: string, name: string): string {
  if (name.startsWith("#")) {
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  }
  return ENTITIES[name] ?? whole;
}

/** Fetches a page, following redirects by hand so every hop is checked before it is asked for. */
async function fetchPage(
  address: string,
  allowLocal: boolean,
  fetcher: typeof fetch,
): Promise<{ url: string; type: string; body: string }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new SearchError(`"${address}" is not a URL`);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new SearchError(`Only http and https pages are read, not ${url.protocol}`);
    try {
      await assertReachable(url, allowLocal);
    } catch (error) {
      throw new SearchError(
        `${(error as Error).message.replace(/; turn on allowPrivateNetwork to reach it$/, "")}: read_page only reads public pages`,
      );
    }
    const response = await fetcher(url, {
      redirect: "manual",
      headers: {
        accept: "text/html,text/plain;q=0.9,*/*;q=0.5",
        "user-agent": "Nudge (read_page)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      url = new URL(response.headers.get("location")!, url);
      continue;
    }
    if (!response.ok) throw new SearchError(`${url.href} answered ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!/^text\/|html|xml|json/.test(type))
      throw new SearchError(`${url.href} is ${type || "not text"}, not a page`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader !== undefined && size < MAX_PAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader?.cancel().catch(() => {});
    return { url: url.href, type, body: Buffer.concat(chunks).toString("utf8") };
  }
  throw new SearchError(`${address} redirects more than ${MAX_REDIRECTS} times`);
}

export type SearchOptions = { readonly fetch?: typeof fetch };

/** The search extension with its HTTP client chosen; the default export uses the global `fetch`. */
export function searchExtension(options: SearchOptions = {}) {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  return defineNudgeExtension({
    name: "search",
    version: VERSION,
    description: "Web search through a SearXNG of your own, and reading a page as text.",
    settings: Settings,
    setup: (host) => {
      const { url, language, maxResults, readLocalPages } = host.settings;
      const text = (value: string, isError = false) => ({
        output: [{ type: "text" as const, text: value }],
        ...(isError ? { isError } : {}),
      });

      const search = defineTool({
        name: "web_search",
        description:
          "Search the web. Gives titles, addresses and snippets; read_page reads one, and the " +
          "browser handles pages that need a person's login or clicking around.",
        parameters: Type.Object({
          query: Type.String(),
          time_range: Type.Optional(
            Type.Union([
              Type.Literal("day"),
              Type.Literal("week"),
              Type.Literal("month"),
              Type.Literal("year"),
            ]),
          ),
          max_results: Type.Optional(Type.Number({ description: `Default ${maxResults}.` })),
        }),
        replay: "safe",
        execute: async (args) => {
          const query = new URLSearchParams({ q: args.query, format: "json", language });
          if (args.time_range !== undefined) query.set("time_range", args.time_range);
          let response: Response;
          try {
            response = await fetcher(`${url.replace(/\/+$/, "")}/search?${query}`, {
              headers: { accept: "application/json" },
              signal: AbortSignal.timeout(20_000),
            });
          } catch (error) {
            return text(`The search engine can't be reached: ${(error as Error).message}`, true);
          }
          if (response.status === 403)
            return text(
              "The search engine refuses JSON: turn on the json format in its settings.yml.",
              true,
            );
          if (!response.ok) return text(`The search engine answered ${response.status}.`, true);
          const body = (await response.json()) as { results?: SearxResult[] };
          const limit = Math.min(Math.max(1, args.max_results ?? maxResults), 30);
          const results = (body.results ?? []).filter((r) => r.url !== undefined).slice(0, limit);
          if (results.length === 0) return text("Nothing found.");
          return text(
            results
              .map((r, i) =>
                [
                  `${i + 1}. ${r.title ?? r.url}`,
                  `   ${r.url}`,
                  ...(r.publishedDate ? [`   ${r.publishedDate.slice(0, 10)}`] : []),
                  ...(r.content ? [`   ${r.content.replace(/\s+/g, " ").slice(0, 300)}`] : []),
                ].join("\n"),
              )
              .join("\n"),
          );
        },
      });

      const read = defineTool({
        name: "read_page",
        description: `Read a web page as text, ${CHUNK} characters at a time from \`offset\`. Public addresses only.`,
        parameters: Type.Object({
          url: Type.String(),
          offset: Type.Optional(Type.Number()),
        }),
        replay: "safe",
        execute: async (args) => {
          try {
            const page = await fetchPage(args.url, readLocalPages, fetcher);
            const { title, text: content } = /html|xml/.test(page.type)
              ? pageText(page.body)
              : { title: "", text: page.body };
            const offset = Math.max(0, Math.floor(args.offset ?? 0));
            const part = content.slice(offset, offset + CHUNK);
            return text(
              `${title === "" ? page.url : `${title} (${page.url})`}, characters ${offset}–${offset + part.length} of ${content.length}:\n\n${part}` +
                (offset + CHUNK < content.length ? `\n\n…more from offset ${offset + CHUNK}.` : ""),
            );
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      return {
        tools: [readsOnly(search), readsOnly(read)],
        // The public web: shops and places in results stay readable (ADR 14).
        publicTools: [search.name, read.name],
        sections: [
          section(
            "search",
            () =>
              "For current facts (news, opening hours, prices, events), search with web_search and " +
              "read a result with read_page rather than answer from memory. A connector or feed the " +
              "room added for the task comes first.",
          ),
        ],
      };
    },
  });
}

export default searchExtension();
