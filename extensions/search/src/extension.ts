import {
  currentTurn,
  defineNudgeExtension,
  defineTool,
  readsOnly,
  requestApproval,
  returnsUntrusted,
  roomOf,
  section,
  Type,
} from "@nudge/core";
import { assertReachable } from "@nudge/ext-connectors";

const VERSION = "0.1.0";
/** Characters of a page `read_page` gives at a time. */
const CHUNK = 8_000;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
/** Addresses of a turn's search results kept per conversation, newest last. */
const KEEP_FOUND = 200;

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

/** An address as `read_page` compares it: no fragment. */
function comparable(address: string): string | undefined {
  try {
    const url = new URL(address);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

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
      // The addresses each conversation's current turn got from web_search: a page there was
      // chosen by the search engine, not by what the turn read (ADR 20). Kept in memory only.
      const found = new Map<number, { start: unknown; urls: string[] }>();
      const foundNow = (conversationId: number) => {
        const { start } = currentTurn();
        const kept = found.get(conversationId);
        if (kept !== undefined && kept.start === start) return kept;
        const fresh = { start, urls: [] as string[] };
        found.set(conversationId, fresh);
        return fresh;
      };
      /** Whether reading `address` now needs a person: the turn read untrusted data, and no
       * person named its host nor did a search of this turn find it. */
      const needsApproval = (conversationId: number, address: string): boolean => {
        const { untrusted, named = [] } = currentTurn();
        if (untrusted === undefined) return false;
        let host: string;
        try {
          host = new URL(address).hostname.toLowerCase().replace(/^www\./, "");
        } catch {
          return false;
        }
        if (named.includes(host)) return false;
        const url = comparable(address);
        return url === undefined || !foundNow(conversationId).urls.includes(url);
      };
      const readPage = async (args: { url: string; offset?: number }) => {
        const page = await fetchPage(args.url, readLocalPages, fetcher);
        const { title, text: content } = /html|xml/.test(page.type)
          ? pageText(page.body)
          : { title: "", text: page.body };
        const offset = Math.max(0, Math.floor(args.offset ?? 0));
        const part = content.slice(offset, offset + CHUNK);
        return (
          `${title === "" ? page.url : `${title} (${page.url})`}, characters ${offset}–${offset + part.length} of ${content.length}:\n\n${part}` +
          (offset + CHUNK < content.length ? `\n\n…more from offset ${offset + CHUNK}.` : "")
        );
      };

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
        execute: async (args, api) => {
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
          const kept = foundNow(api.conversationId);
          for (const result of results) {
            const address = comparable(result.url!);
            if (address !== undefined) kept.urls.push(address);
          }
          kept.urls.splice(0, Math.max(0, kept.urls.length - KEEP_FOUND));
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
        execute: async (args, api, context) => {
          if (needsApproval(api.conversationId, args.url)) {
            const room = await roomOf(api, api.conversationId, context);
            const { untrusted = [] } = currentTurn();
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  {
                    extension: "search",
                    kind: "read",
                    summary:
                      `Read ${args.url}, which nobody here named, after reading ` +
                      `${untrusted.join(", ")}: the address could carry what the conversation holds.`,
                    payload: {
                      url: args.url,
                      ...(args.offset === undefined ? {} : { offset: args.offset }),
                    },
                  },
                  host.now(),
                ),
              context,
            );
            return {
              ...text(
                `Waiting for approval ${approval.id}: this turn read untrusted data, and nobody here ` +
                  `named ${args.url} or found it with web_search. Once someone approves, the page arrives as a new message.`,
              ),
              details: { approval: approval.id },
            };
          }
          try {
            return text(await readPage(args));
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      return {
        // Pages and snippets are written by strangers: the model reads them as data (ADR 20).
        tools: [readsOnly(search), readsOnly(read)].map(returnsUntrusted),
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
        approvals: {
          read: async (payload) => {
            try {
              return {
                text: await readPage(payload as { url: string; offset?: number }),
                untrusted: "read_page",
              };
            } catch (error) {
              return { text: (error as Error).message, isError: true };
            }
          },
        },
      };
    },
  });
}

export default searchExtension();
