import { defineDocFamily, type SessionDocFamilyToken } from "@nudge/core";

// Stored in a document, so plain JSON.
export type RoomFeed = {
  /** `f1`, `f2`, … within its room. */
  id: string;
  name: string;
  url: string;
  /** Who added it: a player's name, or the assistant's. */
  by: string;
  at: number;
};

export type FeedsState = { feeds: RoomFeed[]; next: number };

/** The feeds people added in a room, keyed by room id. */
export const FeedsDoc: SessionDocFamilyToken<FeedsState, null> = defineDocFamily({
  kind: "rss.feeds",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ feeds: [], next: 1 }),
});
