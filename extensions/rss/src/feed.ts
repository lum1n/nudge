import { assertReachable } from "@nudge/ext-connectors";
import { pageText } from "@nudge/ext-search";

const MAX_FEED_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

export class FeedError extends Error {
  override name = "FeedError";
}

/** One story in a feed. */
export type FeedItem = {
  readonly title: string;
  readonly link?: string;
  /** Milliseconds since the epoch, when the feed gives a date it can be read by. */
  readonly published?: number;
  /** The item's text, tags out. */
  readonly summary: string;
};

export type Feed = { readonly title: string; readonly items: readonly FeedItem[] };

/** Whether a document is an RSS (0.9x, 1.0 or 2.0) or Atom feed. */
export function isFeed(xml: string): boolean {
  return /<(rss|feed|rdf:RDF)\b/i.test(xml.slice(0, 4_000));
}

/** The title and items of an RSS or Atom feed, read with patterns rather than a full XML parser. */
export function parseFeed(xml: string): Feed {
  if (!isFeed(xml)) throw new FeedError("This is not an RSS or Atom feed");
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const head = xml.slice(0, blocks[0]?.index ?? xml.length);
  const items = blocks.map(([, , block = ""]): FeedItem => {
    const date = Date.parse(tag(block, ["pubDate", "published", "updated", "dc:date"]) ?? "");
    const link = linkOf(block);
    return {
      title: text(tag(block, ["title"]) ?? "") || "(untitled)",
      ...(link === undefined ? {} : { link }),
      ...(Number.isNaN(date) ? {} : { published: date }),
      summary: text(tag(block, ["description", "summary", "content:encoded", "content"]) ?? ""),
    };
  });
  return { title: text(tag(head, ["title"]) ?? ""), items };
}

/** The feed a web page names in its `<link rel="alternate">`, for when someone gives a site. */
export function discoverFeed(html: string, base: string): string | undefined {
  for (const [whole] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(whole);
    if (
      /\balternate\b/i.test(attrs.rel ?? "") &&
      /application\/(rss|atom)\+xml/i.test(attrs.type ?? "") &&
      attrs.href !== undefined
    )
      try {
        return new URL(decodeXml(attrs.href), base).href;
      } catch {
        continue;
      }
  }
  return undefined;
}

/** The first of `names` the block has, its CDATA unwrapped. */
function tag(block: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.:]/g, "\\$&");
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${escaped}>`, "i").exec(
      block,
    );
    if (match !== null) return match[1];
  }
  return undefined;
}

/** An RSS `<link>`'s text, or the Atom `<link href>` to the item itself. */
function linkOf(block: string): string | undefined {
  const inline = tag(block, ["link"])?.trim();
  if (inline) return decodeXml(unwrap(inline));
  let fallback: string | undefined;
  for (const [whole] of block.matchAll(/<link\b[^>]*>/gi)) {
    const { href, rel } = attributes(whole);
    if (href === undefined) continue;
    if (rel === undefined || rel === "alternate") return decodeXml(href);
    fallback ??= decodeXml(href);
  }
  const guid = tag(block, ["guid", "id"])?.trim();
  return (
    fallback ?? (guid !== undefined && /^https?:\/\//.test(guid) ? decodeXml(guid) : undefined)
  );
}

function attributes(element: string): Record<string, string> {
  return Object.fromEntries(
    [...element.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, name, a, b]) => [
      name!.toLowerCase(),
      a ?? b ?? "",
    ]),
  );
}

/** Text out of a feed field, which may be CDATA, escaped HTML or plain text. */
function text(value: string): string {
  const html = /^\s*<!\[CDATA\[/.test(value) ? unwrap(value) : decodeXml(value);
  return pageText(html).text.replace(/\s+/g, " ").trim();
}

function unwrap(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** XML's own five entities, so escaped HTML becomes HTML; the rest is `pageText`'s. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Fetches a feed or page, following redirects by hand so every hop is checked first. */
export async function fetchFeed(
  address: string,
  allowLocal: boolean,
  fetcher: typeof fetch,
): Promise<{ url: string; body: string }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new FeedError(`"${address}" is not a URL`);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new FeedError(`Only http and https feeds are read, not ${url.protocol}`);
    try {
      await assertReachable(url, allowLocal);
    } catch (error) {
      throw new FeedError(
        `${(error as Error).message.replace(/; turn on allowPrivateNetwork to reach it$/, "")}: only public feeds are read`,
      );
    }
    const response = await fetcher(url, {
      redirect: "manual",
      headers: {
        accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5",
        "user-agent": "Nudge (rss)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      url = new URL(response.headers.get("location")!, url);
      continue;
    }
    if (!response.ok) throw new FeedError(`${url.href} answered ${response.status}`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader !== undefined && size < MAX_FEED_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader?.cancel().catch(() => {});
    return { url: url.href, body: Buffer.concat(chunks).toString("utf8") };
  }
  throw new FeedError(`${address} redirects more than ${MAX_REDIRECTS} times`);
}
