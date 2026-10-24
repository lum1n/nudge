import {
  currentTurn,
  defineNudgeExtension,
  defineTool,
  readsOnly,
  returnsUntrusted,
  roomOf,
  roomsSetting,
  section,
  Type,
} from "@nudge/core";
import { discoverFeed, type FeedItem, FeedError, fetchFeed, isFeed, parseFeed } from "./feed.ts";
import { FeedsDoc, type RoomFeed } from "./model.ts";

const VERSION = "0.1.0";

const FeedSettings = Type.Object({
  name: Type.String({ description: "What the feed is called, such as NRK or Hacker News." }),
  url: Type.String({
    pattern: "^https?://",
    title: "Feed URL",
    description: "The address of the RSS or Atom feed, starting with http:// or https://.",
  }),
  /** Room ids that check the feed; `*` for every room. */
  rooms: roomsSetting({ title: "Rooms", description: "The rooms that check this feed." }),
});

const Settings = Type.Object({
  feeds: Type.Array(FeedSettings, {
    default: [],
    description:
      "Feeds the assistant checks first for news; people can also add their own in a conversation.",
  }),
  maxItems: Type.Number({
    default: 15,
    minimum: 1,
    maximum: 50,
    description: "Most stories one read of the feeds gives the assistant.",
  }),
  maxPerRoom: Type.Number({
    default: 20,
    minimum: 1,
    description: "Most feeds people may add in one conversation.",
  }),
  /** Let feeds be on local addresses too; off, so a feed can't lead it into the house. */
  readLocalFeeds: Type.Boolean({
    default: false,
    description:
      "Let feeds be on localhost and your local network; off, so an added feed can't reach inside.",
  }),
});

/** A feed a room can read: one from the settings, or one someone added there. */
type Usable = { readonly id: string; readonly name: string; readonly url: string };

export type RssOptions = { readonly fetch?: typeof fetch };

/** The RSS extension with its HTTP client chosen; the default export uses the global `fetch`. */
export function rssExtension(options: RssOptions = {}) {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  return defineNudgeExtension({
    name: "rss",
    version: VERSION,
    apiVersion: "1.0",
    description: "RSS and Atom feeds the assistant checks first when asked for news.",
    settings: Settings,
    setup: (host) => {
      const { maxItems, maxPerRoom, readLocalFeeds } = host.settings;
      const configured = host.settings.feeds.map((feed, i) => ({ ...feed, id: `s${i + 1}` }));
      const text = (value: string, isError = false) => ({
        output: [{ type: "text" as const, text: value }],
        ...(isError ? { isError } : {}),
      });
      const when = new Intl.DateTimeFormat("sv-SE", {
        timeZone: host.timeZone,
        dateStyle: "short",
        timeStyle: "short",
      });
      const describe = (feed: Usable) => `${feed.id}: ${feed.name} (${feed.url})`;

      /** The settings' feeds for the room, then the room's own. */
      const usableIn = async (
        read: Parameters<typeof roomOf>[0],
        roomId: string,
        context: Parameters<typeof roomOf>[2],
      ): Promise<Usable[]> => [
        ...configured.filter((feed) => feed.rooms.includes("*") || feed.rooms.includes(roomId)),
        ...((await read.snapshot(FeedsDoc, roomId, context))?.feeds ?? []),
      ];
      const matches = (feed: Usable, ref: string) =>
        feed.id === ref.trim() || feed.name.toLowerCase() === ref.trim().toLowerCase();

      const add = defineTool({
        name: "add_feed",
        description:
          "Add an RSS or Atom feed to this conversation, to check first for news. A site's " +
          "address works too when the site names its feed.",
        parameters: Type.Object({
          url: Type.String(),
          name: Type.Optional(Type.String({ description: "Default the feed's own title." })),
        }),
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          let found: { url: string; body: string };
          try {
            found = await fetchFeed(args.url, readLocalFeeds, fetcher);
            if (!isFeed(found.body)) {
              const linked = discoverFeed(found.body, found.url);
              if (linked === undefined)
                return text(`${found.url} is not a feed and doesn't name one.`, true);
              found = await fetchFeed(linked, readLocalFeeds, fetcher);
            }
            const feed = parseFeed(found.body);
            const name = args.name?.trim() || feed.title || new URL(found.url).hostname;
            const existing = (await usableIn(api, room.id, context)).find(
              (f) => f.url === found.url,
            );
            if (existing !== undefined)
              return text(`This conversation has that feed already: ${describe(existing)}.`);
            const added = await api.commit(async (tx) => {
              const state = await tx.doc(FeedsDoc, room.id, null);
              if (state.feeds.length >= maxPerRoom)
                throw new FeedError(`This conversation has ${maxPerRoom} feeds already`);
              const added: RoomFeed = {
                id: `f${state.next}`,
                name,
                url: found.url,
                by: currentTurn().by?.displayName ?? host.displayName,
                at: host.now(),
              };
              state.next += 1;
              state.feeds.push(structuredClone(added));
              return added;
            }, context);
            return text(`Added feed ${describe(added)}, with ${feed.items.length} stories now.`);
          } catch (error) {
            if (error instanceof FeedError || error instanceof TypeError)
              return text(error.message, true);
            throw error;
          }
        },
      });

      const list = defineTool({
        name: "list_feeds",
        description: "List the feeds this conversation checks, with their ids.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const feeds = await usableIn(api, room.id, context);
          return text(feeds.length === 0 ? "No feeds." : feeds.map(describe).join("\n"));
        },
      });

      const remove = defineTool({
        name: "remove_feed",
        description: "Remove a feed someone added to this conversation, by its id or name.",
        parameters: Type.Object({ feed: Type.String({ description: "From list_feeds." }) }),
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          if (configured.some((feed) => matches(feed, args.feed)))
            return text(
              "That feed is in the assistant's settings; an admin removes it there.",
              true,
            );
          const removed = await api.commit(async (tx) => {
            const state = await tx.doc(FeedsDoc, room.id, null);
            const feed = state.feeds.find((f) => matches(f, args.feed));
            state.feeds = state.feeds.filter((f) => f !== feed);
            return feed === undefined ? undefined : { ...feed };
          }, context);
          return removed === undefined
            ? text(`No feed "${args.feed}" in this conversation.`, true)
            : text(`Removed feed ${describe(removed)}.`);
        },
      });

      const read = defineTool({
        name: "read_feeds",
        description:
          "Read the newest stories from this conversation's feeds, newest first, with their " +
          "links; read_page reads a whole story.",
        parameters: Type.Object({
          feed: Type.Optional(Type.String({ description: "One feed's id or name; default all." })),
          query: Type.Optional(
            Type.String({ description: "Only stories that mention every one of these words." }),
          ),
          max_items: Type.Optional(Type.Number({ description: `Default ${maxItems}.` })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          let feeds = await usableIn(api, room.id, context);
          if (feeds.length === 0)
            return text("This conversation has no feeds; add one with add_feed.");
          if (args.feed !== undefined) {
            feeds = feeds.filter((feed) => matches(feed, args.feed!));
            if (feeds.length === 0) return text(`No feed "${args.feed}" here.`, true);
          }
          const results = await Promise.all(
            feeds.map(async (feed) => {
              try {
                const { body } = await fetchFeed(feed.url, readLocalFeeds, fetcher);
                return { feed, items: parseFeed(body).items };
              } catch (error) {
                return { feed, error: (error as Error).message };
              }
            }),
          );
          const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
          const stories = results
            .flatMap((r) => (r.items ?? []).map((item) => ({ item, feed: r.feed })))
            .filter(({ item }) => {
              const haystack = `${item.title} ${item.summary}`.toLowerCase();
              return words.every((word) => haystack.includes(word));
            })
            .sort(newestFirst)
            .slice(0, Math.min(Math.max(1, args.max_items ?? maxItems), 50));
          const failed = results.flatMap((r) =>
            r.error === undefined ? [] : [`${r.feed.name} couldn't be read: ${r.error}`],
          );
          if (stories.length === 0 && failed.length === results.length)
            return text(failed.join("\n"), true);
          return text(
            [
              ...(stories.length === 0
                ? [words.length === 0 ? "The feeds have no stories." : "No story matches."]
                : stories.map(({ item, feed }, i) =>
                    [
                      `${i + 1}. ${item.title}`,
                      `   ${feed.name}${item.published === undefined ? "" : `, ${when.format(item.published)}`}`,
                      ...(item.link === undefined ? [] : [`   ${item.link}`]),
                      ...(item.summary === "" ? [] : [`   ${item.summary.slice(0, 300)}`]),
                    ].join("\n"),
                  )),
              ...failed,
            ].join("\n"),
          );
        },
      });

      return {
        tools: [add, readsOnly(list), remove, returnsUntrusted(readsOnly(read))],
        // The news: places and names in stories stay readable, as in a web search (ADR 14).
        publicTools: [read.name],
        sections: [
          section("rss", async (input, context) => {
            const room = await roomOf(input.read, input.conversationId, context).catch(
              () => undefined,
            );
            if (room === undefined) return undefined;
            const feeds = await usableIn(input.read, room.id, context);
            if (feeds.length === 0)
              return "People can add RSS or Atom feeds to this conversation (add_feed) for you to check first for news.";
            return (
              `This conversation's news feeds: ${feeds.map((feed) => feed.name).join(", ")}. ` +
              "When asked for the latest news, or anything these feeds cover, read them with " +
              "read_feeds first, and search the web only for what they don't answer."
            );
          }),
        ],
      };
    },
  });
}

/** Dated stories newest first, undated ones after them. */
function newestFirst(a: { item: FeedItem }, b: { item: FeedItem }): number {
  return (b.item.published ?? -Infinity) - (a.item.published ?? -Infinity) || 0;
}

export default rssExtension();
