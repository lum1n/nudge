import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import type { Player, Room } from "@nudge/core";

// HTTP, under /a/<assistant>, with `Authorization: Bearer <token>`.

/** GET /me */
export type MeResponse = {
  readonly assistant: { readonly name: string; readonly displayName: string };
  readonly player: Player;
  readonly clientId: string;
  readonly rooms: readonly Room[];
};

/** GET /rooms/<room> */
export type RoomResponse = { readonly room: Room; readonly members: readonly Player[] };

/** POST /rooms. The caller is always a member. */
export type CreateRoomRequest = {
  readonly name: string;
  readonly members?: readonly string[];
  readonly id?: string;
};

export type WhenBusy = "steer" | "followUp" | "reject";

/** POST /rooms/<room>/messages, and the `submit` frame. */
export type MessageRequest = {
  readonly text: string;
  readonly requestId?: string;
  readonly whenBusy?: WhenBusy;
};

export type MessageResponse = { readonly submissionId: number };

/** GET /rooms/<room>/transcript?limit=&before=. Newest first; `before` comes from `next`. */
export type TranscriptResponse = {
  readonly entries: readonly EntryRecord[];
  readonly next?: string;
};

/** POST /protect */
export type ProtectRequest = { readonly value: string; readonly kind?: string };
export type ProtectResponse = { readonly placeholder: string };

export type ErrorResponse = { readonly error: string };

// WebSocket, GET /a/<assistant>/rooms/<room>/stream. The first client frame is `hello`.

export type ClientFrame =
  | { readonly type: "hello"; readonly token: string }
  | ({ readonly type: "submit" } & MessageRequest)
  | { readonly type: "abort" };

export type ServerFrame =
  /** First frame after a good hello: the room so far. */
  | SnapshotEvent
  /** One batch per commit; a slow client may get a fresh `snapshot` inside. */
  | { readonly type: "events"; readonly events: readonly AgentEvent[] }
  | { readonly type: "submitted"; readonly requestId?: string; readonly submissionId: number }
  | { readonly type: "error"; readonly message: string; readonly requestId?: string };

/** Close codes, after HTTP status codes. */
export const CLOSE = {
  unauthorized: 4401,
  notFound: 4404,
  badRequest: 4400,
  /** The assistant shut down. */
  goingAway: 1001,
} as const;
