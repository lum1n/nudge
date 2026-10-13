import { createHash, randomBytes } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";

// Stored in a document, so plain JSON: no readonly arrays.
export type Player = {
  /** URL-safe and stable; derived from the first display name. */
  id: string;
  displayName: string;
  createdAt: number;
};

/** A credential for one client of one player. Only its hash is stored. */
export type TokenRecord = {
  playerId: string;
  clientId: string;
  createdAt: number;
};

/**
 * `lobby`: the root conversation, open to every player. `personal`: one player's own room.
 * `shared`: the members listed.
 */
export type RoomKind = "lobby" | "personal" | "shared";

export type Room = {
  /** URL-safe. */
  id: string;
  conversationId: number;
  kind: RoomKind;
  name: string;
  /** Player ids; empty for the lobby, which everyone may use. */
  members: string[];
  createdAt: number;
};

export type DirectoryState = {
  players: Record<string, Player>;
  /** Keyed by the token's SHA-256, hex. */
  tokens: Record<string, TokenRecord>;
  rooms: Record<string, Room>;
};

/** Who uses the assistant and where: players, their tokens and the rooms index. One per storage. */
export const DirectoryDoc = defineDoc<DirectoryState>({
  kind: "nudge.directory",
  version: 1,
  scope: "session",
  initial: () => ({ players: {}, tokens: {}, rooms: {} }),
});

export const LOBBY = "lobby";

const TOKEN_PREFIX = "nudge_";

export function newToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** `"Ann Marie"` → `"ann-marie"`; falls back to `fallback` when nothing URL-safe is left. */
export function slug(text: string, fallback: string): string {
  const base = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base === "" ? fallback : base;
}

/** `base`, or `base-2`, `base-3`, … whichever is not taken. */
export function freeId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

export function canUse(room: Room, playerId: string): boolean {
  return room.kind === LOBBY || room.members.includes(playerId);
}
