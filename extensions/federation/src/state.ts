import { defineDoc } from "@earendil-works/pi-durable";
import type { PlayerHome } from "@nudge/core";

/** An assistant other people may join from: its server and its name there. */
export type Place = { server: string; assistant: string };

/** Someone an admin here asked to join, by their address. */
export type Invite = {
  id: string;
  home: PlayerHome;
  /** The admin who invited them. */
  by: string;
  createdAt: number;
  expiresAt: number;
};

/** A player here whose home is elsewhere: the key their home signs with, pinned when they joined. */
export type Guest = {
  key: string;
  /** When the home signed the profile applied last; older ones are stale. */
  profileAt: number;
};

// Stored in a document, so plain JSON.
export type FederationState = {
  /** Here as the place people join: open invites by id. */
  invites: Record<string, Invite>;
  /** Here as the place people join: players from elsewhere, by player id. */
  guests: Record<string, Guest>;
  /** Here as a home: where each of its players went, by player id. */
  memberships: Record<string, (Place & { since: number })[]>;
  /** Join assertions already used, until they expire, so none is used twice. */
  used: Record<string, number>;
};

export const FederationDoc = defineDoc<FederationState>({
  kind: "nudge.federation",
  version: 1,
  scope: "session",
  initial: () => emptyState(),
});

export function emptyState(): FederationState {
  return { invites: {}, guests: {}, memberships: {}, used: {} };
}

export function samePlace(a: Place, b: Place): boolean {
  return a.server === b.server && a.assistant === b.assistant;
}
