import { defineDoc } from "@earendil-works/pi-durable";
import type { PlayerHome } from "@nudge/core";

/** An assistant other people may join from: its server and its name there. */
export type Place = { server: string; assistant: string };

/** The keys an assistant publishes, pinned the first time this one met it. */
export type Keys = {
  /** Ed25519: checks what it signed. */
  signingKey: string;
  /** X25519: what only it may read is encrypted to this. */
  encryptionKey: string;
};

/** Someone an admin here asked to join, by their address. */
export type Invite = {
  id: string;
  home: PlayerHome;
  /** The admin who invited them. */
  by: string;
  createdAt: number;
  expiresAt: number;
};

/** A player here whose home is elsewhere, with their home's keys. */
export type Guest = Keys & {
  /** When the home signed the last message of each kind applied, so older ones are refused. */
  seen: Record<string, number>;
  /** Whether their home carries their own memory here. */
  carry: boolean;
  /** Their own facts here that came from home: the id here, then the id at home. */
  carried: Record<string, string>;
  /** Facts they remembered here, sent home and waiting to come back with the next memory. */
  forwarded: string[];
};

/** Here as a home: one assistant one of its players joined, with its keys. */
export type Membership = Place &
  Keys & {
    since: number;
    /** The player agreed to have their own memory carried there. */
    carry: boolean;
    /** When it signed the last message of each kind taken from it. */
    seen: Record<string, number>;
  };

// Stored in a document, so plain JSON.
export type FederationState = {
  /** Here as the place people join: open invites by id. */
  invites: Record<string, Invite>;
  /** Here as the place people join: players from elsewhere, by player id. */
  guests: Record<string, Guest>;
  /** Here as a home: where each of its players went, by player id. */
  memberships: Record<string, Membership[]>;
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
