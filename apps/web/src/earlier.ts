import type { EntryRecord } from "@earendil-works/pi-durable";
import type { TranscriptResponse } from "@nudge/server";
import { useCallback, useEffect, useState } from "react";
import { transcript } from "./api.ts";
import type { ConversationView } from "./mirror.ts";

/** A page's worth of pages is enough to not spin forever on a conversation full of resets. */
const MAX_EMPTY_PAGES = 20;

/** History loaded by `onLoadEarlier`, oldest first, to prepend before the live view's entries. */
export type EarlierHistory = {
  readonly entries: readonly EntryRecord[];
  readonly cursor?: string;
  readonly hasMore: boolean;
};

export const NO_HISTORY: EarlierHistory = { entries: [], hasMore: true };

/**
 * Folds in one `/transcript` page (newest first). Its fork-aware history can retread entries the
 * live view already shows (no reset happened since), so entries already in `known` are dropped;
 * `history.entries` only grows when the page turns up something new.
 */
export function applyTranscriptPage(
  history: EarlierHistory,
  page: TranscriptResponse,
  known: ReadonlySet<string>,
): EarlierHistory {
  const added = page.entries.filter((entry) => !known.has(String(entry.id))).reverse();
  return {
    entries: added.length === 0 ? history.entries : [...added, ...history.entries],
    cursor: page.next,
    hasMore: page.next !== undefined,
  };
}

/** Loads a room's history page by page, for `useExternalStoreRuntime`'s `onLoadEarlier`. */
export function useEarlierHistory(
  assistant: string,
  room: string,
  view: ConversationView | undefined,
): { entries: readonly EntryRecord[]; hasEarlier: boolean; loadEarlier: () => Promise<void> } {
  const [history, setHistory] = useState(NO_HISTORY);
  useEffect(() => setHistory(NO_HISTORY), [assistant, room]);

  const loadEarlier = useCallback(async () => {
    let current = history;
    for (let page = 0; page < MAX_EMPTY_PAGES && current.hasMore; page++) {
      const known = new Set(
        [...current.entries, ...(view?.entries ?? [])].map((entry) => String(entry.id)),
      );
      const before = current.entries.length;
      current = applyTranscriptPage(
        current,
        await transcript(assistant, room, current.cursor),
        known,
      );
      if (current.entries.length > before) break;
    }
    setHistory(current);
  }, [assistant, room, history, view]);

  return { entries: history.entries, hasEarlier: history.hasMore, loadEarlier };
}
