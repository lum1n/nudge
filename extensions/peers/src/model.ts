import { defineDoc, type SessionDocToken } from "@nudge/core";
import { type Keys, type Place, samePlace } from "@nudge/ext-federation";

/** The player something private belongs to, with the name others are told it went to. */
export type Owner = { playerId: string; displayName: string };

// Stored in a document, so plain JSON.
export type Link = {
  /** `l1`, `l2`, … on this assistant. */
  id: string;
  place: Place;
  /** The other assistant's keys, pinned when they first met. */
  keys: Keys;
  /** What the other assistant calls itself. */
  displayName: string;
  /**
   * `asked`: this side sent the request and waits for theirs to agree; `incoming`: they asked and
   * an admin here decides; `linked`: both agreed.
   */
  status: "asked" | "incoming" | "linked";
  /** What whoever asked said about why. */
  note?: string;
  /** The room the link was asked from, which hears how it ended. */
  askedIn?: string;
  /** The approval an admin here decides an incoming request with. */
  approvalId?: string;
  /** Once linked: the player the other assistant speaks as here, and its room. */
  playerId?: string;
  roomId?: string;
  /** The newest `issuedAt` seen per kind, so a replayed message changes nothing. */
  seen: Record<string, number>;
  /** Threads they started here this hour, for `maxThreadsPerHour`. */
  started: { hourStart: number; count: number };
  createdAt: number;
};

export type ThreadMessage = { from: "us" | "them"; text: string; at: number };

export type Thread = {
  /** The same on both sides. */
  id: string;
  linkId: string;
  /** `out`: started here, worked in a side conversation of `originRoomId`; `in`: started there. */
  direction: "out" | "in";
  goal?: string;
  /** What the room told the model about it, for the side conversation. */
  brief?: string;
  originRoomId?: string;
  /** The timer that starts it and ends it when it waits too long, as a string. */
  taskId?: string;
  sideId?: number;
  /** Who started it here, whose values may go out in it. */
  startedBy?: Owner;
  /** Started in a private turn: only this player hears how it went. */
  privateTo?: Owner;
  /** How many messages this side sent, and the last one taken from theirs. */
  sent: number;
  received: number;
  /** `in`: the last of their messages this side answered. */
  answered?: number;
  /** Replies this side's model answered, out of `maxRounds`. */
  rounds: number;
  status: "open" | "done";
  /** `out`: waiting for their reply; `in`: a reply is on its way back. */
  awaiting: boolean;
  /** When an `out` thread gives up waiting. */
  deadline?: number;
  messages: ThreadMessage[];
  summary?: string;
  createdAt: number;
};

/**
 * A reply to a thread the other side started, kept until it took it: stored before it goes, so
 * one on its way when the server restarts is sent once it is back.
 */
export type Outgoing = {
  linkId: string;
  threadId: string;
  seq: number;
  text: string;
  late: boolean;
  /** Tries that failed so far, for the backoff. */
  tries: number;
  /** When it is tried next. */
  nextAt: number;
  /** When it stops being tried: the asking side has stopped waiting for it by then. */
  deadline: number;
};

export type PeersState = {
  links: Record<string, Link>;
  threads: Record<string, Thread>;
  /** Replies on their way, by `outgoingId`. */
  outbox: Record<string, Outgoing>;
  next: number;
};

export const PeersDoc: SessionDocToken<PeersState> = defineDoc({
  kind: "peers.state",
  version: 2,
  scope: "session",
  initial: () => ({ links: {}, threads: {}, outbox: {}, next: 1 }),
  // Version 2 added the outbox.
  migrate: (value) => ({ ...(value as Omit<PeersState, "outbox">), outbox: {} }),
});

/** An outgoing reply's key in the outbox. */
export function outgoingId(threadId: string, seq: number): string {
  return `${threadId}:${seq}`;
}

/** Messages kept per thread; the oldest go first. */
export const MAX_MESSAGES = 40;
/** Threads kept once done, newest first, for `show_thread`. */
export const KEEP_DONE = 50;

/** The link with `place`, if there is one. */
export function linkWith(state: PeersState, place: Place): Link | undefined {
  return Object.values(state.links).find((link) => samePlace(link.place, place));
}

/** Drops the oldest finished threads past `KEEP_DONE`. */
export function pruneThreads(state: PeersState): void {
  const done = Object.values(state.threads)
    .filter((thread) => thread.status === "done")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const thread of done.slice(KEEP_DONE)) delete state.threads[thread.id];
}
