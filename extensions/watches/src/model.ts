import { defineDocFamily } from "@earendil-works/pi-durable";

// Stored in a document, so plain JSON.
export type Watch = {
  /** `w1`, `w2`, … within its room. */
  id: string;
  roomId: string;
  /** What to check, in the room's words. */
  what: string;
  /** Milliseconds between checks. */
  every: number;
  /** The timer task's id, as a string. */
  taskId: string;
  /** The side conversation the checks run in, once the first check made it. */
  sideId?: number;
  /** Keys of the items found so far, newest last; an item whose key is here isn't news. */
  seen: string[];
  checks: number;
  lastCheckAt?: number;
  /** How many new items the last check found. */
  lastFound?: number;
  /** Why the last check failed, if it did. */
  lastError?: string;
  createdAt: number;
  /** Added in answer to something private: only this player hears what it finds. */
  privateTo?: { playerId: string; displayName: string };
};

export type WatchesState = { items: Watch[]; next: number };

/** A room's watches, keyed by room id. */
export const WatchesDoc = defineDocFamily<WatchesState, null>({
  kind: "watches.list",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ items: [], next: 1 }),
});

/** Keys remembered per watch; the oldest go first. */
export const MAX_SEEN = 500;

/** One thing a check found. */
export type Found = { readonly key: string; readonly text: string };

/**
 * The items in a check's reply: the last JSON object in it with an `items` array. Undefined when
 * there is none, so a reply that went wrong isn't taken for "nothing matches".
 */
export function parseFound(reply: string): Found[] | undefined {
  const text = reply.replace(/```(?:json)?/g, "");
  const starts = [...text.matchAll(/\{\s*"items"\s*:/g)].map((match) => match.index).reverse();
  for (const start of starts) {
    // The object ends at one of the closing braces after it; try the furthest first.
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
      let value: unknown;
      try {
        value = JSON.parse(text.slice(start, end + 1));
      } catch {
        continue;
      }
      const items = (value as { items?: unknown }).items;
      if (!Array.isArray(items)) break;
      return items.flatMap((item) => {
        const { key, text } = (item ?? {}) as { key?: unknown; text?: unknown };
        if (typeof key !== "string" || key.trim() === "") return [];
        return [{ key: key.trim(), text: typeof text === "string" ? text.trim() : key.trim() }];
      });
    }
  }
  return undefined;
}

/** `seen` with `keys` added at the end, without repeats, at most `MAX_SEEN` long. */
export function remember(seen: readonly string[], keys: readonly string[]): string[] {
  const added = keys.filter((key, i) => !seen.includes(key) && keys.indexOf(key) === i);
  return [...seen, ...added].slice(-MAX_SEEN);
}
