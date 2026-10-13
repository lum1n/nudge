import type { WireOp } from "@earendil-works/chord/delta";
import type {
  AgentEvent,
  ConversationView,
  EntryRecord,
  SnapshotEvent,
} from "@earendil-works/pi-durable";
import type { Fact, Player, Room, ScheduledNudge } from "@nudge/core";

/** What the view's `nudge.message` and `nudge.fire` entries hold, for clients that render them. */
export type { FireEntryData, MessageEntryData } from "@nudge/core";

/** GET /a, without a token: which assistants this server hosts. The web UI signs in with it. */
export type AssistantsResponse = {
  readonly assistants: readonly { readonly name: string; readonly displayName: string }[];
};

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

/** GET /nudges: pending nudges of the rooms the caller may use, soonest first. */
export type NudgesResponse = { readonly nudges: readonly ScheduledNudge[] };

// DELETE /nudges/<id> cancels one: 204, or 404 when it is not pending in a room the caller may use.

/** GET /rooms/<room>/memory: what the assistant remembers in the room, oldest first. */
export type MemoryResponse = { readonly facts: readonly Fact[] };

/** POST /rooms/<room>/memory → 201 with the new `Fact`. */
export type RememberRequest = { readonly text: string };

// DELETE /rooms/<room>/memory/<id> forgets one: 204, or 404 when the room has no such fact.

export type ErrorResponse = { readonly error: string };

// WebSocket, GET /a/<assistant>/rooms/<room>/stream[?format=view]. The first client frame is `hello`.
// By default the server sends agent events (`snapshot`, then `events`). With `?format=view` it sends
// the room's conversation view instead (`view`, then `ops`), for clients that mirror it.

export type ClientFrame =
  | { readonly type: "hello"; readonly token: string }
  | ({ readonly type: "submit" } & MessageRequest)
  | { readonly type: "abort" };

export type ServerFrame =
  /** First frame after a good hello: the room so far. */
  | SnapshotEvent
  /** One batch per commit; a slow client may get a fresh `snapshot` inside. */
  | { readonly type: "events"; readonly events: readonly AgentEvent[] }
  /** `?format=view`: first frame after a good hello, the view as JSON, without `pi.provider`. */
  | { readonly type: "view"; readonly value: ConversationView }
  /**
   * `?format=view`: one per commit that changes the view. Chord ops from one `encoder()` per socket,
   * so decode them with one `decoder()` per socket, in order. A slow client may get `["r", view]`,
   * which replaces the whole view.
   */
  | { readonly type: "ops"; readonly ops: readonly WireOp[] }
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
