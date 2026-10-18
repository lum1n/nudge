import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { type DocumentReader, defineDoc } from "@earendil-works/pi-durable";

// Stored in a document, so plain JSON: no readonly arrays.
export type Player = {
  /** URL-safe and stable; derived from the first display name. */
  id: string;
  displayName: string;
  createdAt: number;
  /** May use the admin API. The first player may too, flag or not. */
  admin?: boolean;
  /** Set for someone whose home is another assistant, which vouches for them (ADR 10). */
  home?: PlayerHome;
};

/** Where a roaming player's home is: the server, the assistant on it, and their id there. */
export type PlayerHome = {
  /** Origin and any path before `/v1`, such as `https://nudge.example.com`. */
  server: string;
  assistant: string;
  playerId: string;
};

const ID = /^[a-z0-9][a-z0-9-]*$/;
/** Hosts reached over plain HTTP: this computer, and Wired, which encrypts on its own. */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.[a-z0-9-]+\.wired)(:\d+)?$/i;

/**
 * How people write where someone lives: `vegard@nudge.example.com/robin`, their id at home, then
 * the home's server without `https://` and the assistant's name.
 */
export function addressOf(home: PlayerHome): string {
  const server = home.server.replace(/^https:\/\//, "").replace(/\/+$/, "");
  return `${home.playerId}@${server}/${home.assistant}`;
}

/**
 * The home an address names; undefined when it isn't one. The server is HTTPS, except on this
 * computer and over Wired (`nudge.robin.wired`), and `http://` or `https://` may be written out.
 */
export function parseAddress(address: string): PlayerHome | undefined {
  const match = /^([^@\s]+)@(\S+)\/([^/\s]+)$/.exec(address.trim());
  if (match === null) return undefined;
  const [, playerId, where, assistant] = match as unknown as [string, string, string, string];
  if (!ID.test(playerId) || !ID.test(assistant)) return undefined;
  const scheme = /^https?:\/\//.exec(where)?.[0];
  const rest = scheme === undefined ? where : where.slice(scheme.length);
  const host = rest.split("/")[0]!;
  let url: URL;
  try {
    url = new URL(`${scheme ?? (LOCAL.test(host) ? "http://" : "https://")}${rest}`);
  } catch {
    return undefined;
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "") return undefined;
  return { server: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, assistant, playerId };
}

/** Whether two homes are the same person's. */
export function sameHome(a: PlayerHome, b: PlayerHome): boolean {
  return a.server === b.server && a.assistant === b.assistant && a.playerId === b.playerId;
}

/** A credential for one client of one player. Only its hash is stored. */
export type TokenRecord = {
  playerId: string;
  clientId: string;
  createdAt: number;
  /** What the client said it is when it paired. */
  client?: ClientInfo;
};

export type ClientInfo = { name: string; platform: string };

/** A one-time code that turns into a token for `playerId`. Only its hash is stored. */
export type PairingRecord = {
  playerId: string;
  createdAt: number;
  expiresAt: number;
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
  /** Extensions turned on or off in this room, by name; the others follow the config. */
  extensions?: Record<string, boolean>;
};

export type DirectoryState = {
  players: Record<string, Player>;
  /** Keyed by the token's SHA-256, hex. */
  tokens: Record<string, TokenRecord>;
  rooms: Record<string, Room>;
  /** Keyed by the code's SHA-256, hex. Absent in directories from before pairing. */
  pairing?: Record<string, PairingRecord>;
  /**
   * Side conversations by conversation id: work a room's assistant does out of the room's sight,
   * such as a watch's checks. Tools and sections there see the room.
   */
  sides?: Record<string, SideConversation>;
};

export type SideConversation = { roomId: string; createdAt: number };

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

/** Crockford's base 32: no I, L, O or U, so a code typed from a screen comes out right. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `XXXX-XXXX`: 40 bits, enough for a code that works once within minutes. */
export function newPairingCode(): string {
  const chars = [...randomBytes(8)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** The form a pairing code is hashed in: upper case, no spaces or dashes, O as 0, I and L as 1. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
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

/**
 * The room a conversation is, or works for as a side conversation, for tools and sections, which
 * only know the conversation.
 */
export async function roomOf(
  read: DocumentReader,
  conversationId: number,
  context: Context,
): Promise<Room> {
  const directory = await read.snapshot(DirectoryDoc, context);
  const rooms = Object.values(directory?.rooms ?? {});
  const side = directory?.sides?.[String(conversationId)];
  const room =
    side === undefined
      ? rooms.find((r) => r.conversationId === conversationId)
      : directory?.rooms[side.roomId];
  if (room === undefined) throw new Error(`Conversation ${conversationId} is not a room`);
  return room;
}
