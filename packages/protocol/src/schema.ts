import { type Static, Type } from "typebox";

/**
 * The shapes of protocol v1, as TypeBox schemas and the types they stand for. `docs/protocol/v1.md`
 * explains them; `pnpm -C packages/protocol schema` writes them to `schema/v1.json` for clients in
 * other languages. Objects allow extra keys, so a field added within v1 doesn't break old clients.
 */

export const PROTOCOL_VERSION = 1;

export const Player = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  /** Where someone from another assistant lives, such as `vegard@nudge.example.com/robin`. */
  address: Type.Optional(Type.String()),
});
export type Player = Static<typeof Player>;

export const RoomKind = Type.Union([
  Type.Literal("lobby"),
  Type.Literal("personal"),
  Type.Literal("shared"),
]);
export type RoomKind = Static<typeof RoomKind>;

/** The lobby lists no members: everyone may use it. */
export const Room = Type.Object({
  id: Type.String(),
  kind: RoomKind,
  name: Type.String(),
  members: Type.Array(Player),
  /** The model gets the images people attach here as they are (ADR 24); off when absent. */
  imagesToModel: Type.Optional(Type.Boolean()),
});
export type Room = Static<typeof Room>;

export const ApprovalStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("done"),
  Type.Literal("failed"),
]);
export type ApprovalStatus = Static<typeof ApprovalStatus>;

/** Largest attachment, in bytes. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Most attachments one message names. */
export const ATTACHMENTS_PER_MESSAGE = 8;

/**
 * A file someone attached to a message (ADR 24). Its bytes come from
 * `GET /rooms/<room>/attachments/<id>`.
 */
export const Attachment = Type.Object({
  /** `a1`, `a2`, … within its room. */
  id: Type.String(),
  name: Type.String(),
  /** Its media type, such as `image/jpeg`. */
  mime: Type.String(),
  /** In bytes. */
  size: Type.Integer({ minimum: 0 }),
  /** `image` for PNG, JPEG, GIF and WebP, which can reach the model; `file` for the rest. */
  kind: Type.Union([Type.Literal("image"), Type.Literal("file")]),
});
export type Attachment = Static<typeof Attachment>;

// The timeline: what a chat shows, oldest first.

export const ToolPart = Type.Object({
  type: Type.Literal("tool"),
  callId: Type.String(),
  name: Type.String(),
  args: Type.Record(Type.String(), Type.Unknown()),
  status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done")]),
  /** The result's text, once there is one. */
  result: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
  /** What the tool returned for UIs, such as the browser's login button. */
  details: Type.Optional(Type.Unknown()),
  /** What the tool printed so far, while it runs. */
  output: Type.Optional(Type.String()),
  /** `result` was cut, or `details` left out, for being too long. */
  truncated: Type.Optional(Type.Boolean()),
});
export type ToolPart = Static<typeof ToolPart>;

export const Part = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("reasoning"), text: Type.String() }),
  ToolPart,
]);
export type Part = Static<typeof Part>;

export const TimelineItem = Type.Union([
  /** A message. `author` is absent for input without a player, such as the in-process CLI's. */
  Type.Object({
    type: Type.Literal("user"),
    id: Type.String(),
    text: Type.String(),
    author: Type.Optional(Player),
    sentAt: Type.Optional(Type.Number()),
    clientId: Type.Optional(Type.String()),
    /** The id its sender chose, so that sender can swap its optimistic copy for this one. */
    requestId: Type.Optional(Type.String()),
    /** A private message: only its author sees the text; everyone else gets it empty. */
    privateTo: Type.Optional(Player),
    /** What it was sent with; left out for those a private message isn't for. */
    attachments: Type.Optional(Type.Array(Attachment)),
  }),
  /** A scheduled nudge that fired; the assistant answers it like a message. */
  Type.Object({
    type: Type.Literal("nudge"),
    id: Type.String(),
    text: Type.String(),
    firedAt: Type.Number(),
    /** Only this player sees it; everyone else gets it emptied, so they know there was one. */
    privateTo: Type.Optional(Player),
  }),
  /** How an action people were asked to approve ended; the assistant answers it like a message. */
  Type.Object({
    type: Type.Literal("approval"),
    id: Type.String(),
    approvalId: Type.String(),
    summary: Type.String(),
    status: ApprovalStatus,
    /** The display name of who decided. */
    decidedBy: Type.Optional(Type.String()),
    /** Only this player sees it; everyone else gets it emptied, so they know there was one. */
    privateTo: Type.Optional(Player),
  }),
  /** One answer: every model response and tool round between two messages. */
  Type.Object({
    type: Type.Literal("answer"),
    id: Type.String(),
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("stopped"),
      Type.Literal("failed"),
    ]),
    error: Type.Optional(Type.String()),
    parts: Type.Array(Part),
    /** When its first model response started, in ms since the epoch. */
    startedAt: Type.Optional(Type.Number()),
    /** It answers a fired nudge, or what a watch found, rather than a message. */
    promptedBy: Type.Optional(Type.Union([Type.Literal("nudge"), Type.Literal("watch")])),
    /** It answers something private: only this player sees its parts; everyone else gets none. */
    privateTo: Type.Optional(Player),
  }),
  /** Where the transcript starts over: earlier messages were summarized, or cleared. */
  Type.Object({
    type: Type.Literal("marker"),
    id: Type.String(),
    kind: Type.Union([Type.Literal("compacted"), Type.Literal("reset")]),
  }),
]);
export type TimelineItem = Static<typeof TimelineItem>;

// The room view.

export const Status = Type.Union([
  Type.Object({
    kind: Type.Literal("retrying"),
    attempt: Type.Integer(),
    at: Type.Number(),
    error: Type.String(),
  }),
  Type.Object({ kind: Type.Literal("compacting") }),
  Type.Object({ kind: Type.Literal("compaction-failed"), error: Type.String() }),
]);
export type Status = Static<typeof Status>;

/** A message waiting for the assistant to get to it. */
export const QueuedMessage = Type.Object({
  id: Type.Integer(),
  mode: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
  text: Type.String(),
  author: Type.Optional(Player),
  /** As on a user item: its sender can tell its own message from the queue. */
  clientId: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()),
  /** A fired nudge or an ended approval rather than someone's message. */
  nudge: Type.Boolean(),
  /** Only this player sees it; everyone else gets it emptied, so they know there was one. */
  privateTo: Type.Optional(Player),
  /** As on a user item. */
  attachments: Type.Optional(Type.Array(Attachment)),
});
export type QueuedMessage = Static<typeof QueuedMessage>;

export const Approval = Type.Object({
  /** `a1`, `a2`, … within its room. */
  id: Type.String(),
  summary: Type.String(),
  status: ApprovalStatus,
  requestedAt: Type.Number(),
  decidedBy: Type.Optional(Player),
  decidedAt: Type.Optional(Type.Number()),
  /** What the action reported, once it ran. */
  result: Type.Optional(Type.String()),
  /** Asked for in answer to something private: only this player sees and decides it. */
  privateTo: Type.Optional(Player),
  /** Only an admin may decide it. */
  adminOnly: Type.Optional(Type.Boolean()),
});
export type Approval = Static<typeof Approval>;

export const Fact = Type.Object({
  id: Type.String(),
  text: Type.String(),
  createdAt: Type.Number(),
  /** Who remembered it; absent when the assistant did. */
  by: Type.Optional(Player),
  /** Set on a member's own fact that the room shows because they share their memory. */
  owner: Type.Optional(Player),
  /** Remembered in answer to something private: only this player sees it. */
  privateTo: Type.Optional(Player),
});
export type Fact = Static<typeof Fact>;

export const RoomNudge = Type.Object({
  id: Type.String(),
  message: Type.String(),
  fireAt: Type.Number(),
  /** Repeat interval in ms; absent for a one-off. */
  every: Type.Optional(Type.Number()),
  /** Scheduled in answer to something private: only this player sees it, and what it leads to. */
  privateTo: Type.Optional(Player),
});
export type RoomNudge = Static<typeof RoomNudge>;

export const RoomView = Type.Object({
  room: Room,
  /** The most recent items, oldest first. */
  timeline: Type.Array(TimelineItem),
  /** More items come from `GET /rooms/<id>/timeline`. */
  hasEarlier: Type.Boolean(),
  live: Type.Object({ running: Type.Boolean(), status: Type.Optional(Status) }),
  queue: Type.Array(QueuedMessage),
  /** Pending ones and the most recently decided, newest first. */
  approvals: Type.Array(Approval),
  /** Oldest first. */
  memory: Type.Array(Fact),
  /** Soonest first. */
  nudges: Type.Array(RoomNudge),
  /**
   * The members whose location the model may know here: a personal room's owner once their device
   * shared one, and in a shared room those who chose to share it there (`PUT /rooms/<id>/location`).
   */
  sharingLocation: Type.Optional(Type.Array(Player)),
});
export type RoomView = Static<typeof RoomView>;

// The room list: the player's rooms and nudges.

export const RoomListEntry = Type.Object({
  room: Room,
  running: Type.Boolean(),
  pendingApprovals: Type.Integer(),
  lastItemAt: Type.Optional(Type.Number()),
});
export type RoomListEntry = Static<typeof RoomListEntry>;

export const RoomListNudge = Type.Object({
  id: Type.String(),
  roomId: Type.String(),
  message: Type.String(),
  fireAt: Type.Number(),
  every: Type.Optional(Type.Number()),
  privateTo: Type.Optional(Player),
});
export type RoomListNudge = Static<typeof RoomListNudge>;

const Colour = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });

/**
 * How the assistant's robot looks in the apps. Clients draw the robot of the app icon for an
 * eye shape or accessory they don't know, as for none at all.
 */
export const Appearance = Type.Object({
  /** The ribbon's two ends. (Not a `Type.Tuple`, which the JSON schema would write in draft-07.) */
  body: Type.Unsafe<[string, string]>(Type.Array(Colour, { minItems: 2, maxItems: 2 })),
  eyes: Colour,
  sparks: Colour,
  eyeShape: Type.Union([
    Type.Literal("pill"),
    Type.Literal("round"),
    Type.Literal("square"),
    Type.Literal("wide"),
  ]),
  accessory: Type.Union([
    Type.Literal("none"),
    Type.Literal("antenna"),
    Type.Literal("headphones"),
    Type.Literal("sprout"),
    Type.Literal("crown"),
  ]),
});
export type Appearance = Static<typeof Appearance>;

export const RoomListView = Type.Object({
  player: Player,
  rooms: Type.Array(RoomListEntry),
  /** Soonest first. */
  nudges: Type.Array(RoomListNudge),
  /** The assistant's robot; the app icon's when absent. */
  appearance: Type.Optional(Appearance),
});
export type RoomListView = Static<typeof RoomListView>;

// Patches.

/** Object keys and array indexes into a view. */
export const Path = Type.Array(Type.Union([Type.String(), Type.Integer({ minimum: 0 })]));
export type Path = Static<typeof Path>;

export const Op = Type.Union([
  /** Set the value at `path`, adding the key if it's new. An empty path replaces the view. */
  Type.Object({ op: Type.Literal("set"), path: Path, value: Type.Unknown() }),
  /** Remove an object key. */
  Type.Object({ op: Type.Literal("del"), path: Path }),
  /** Append to the string at `path`. */
  Type.Object({ op: Type.Literal("append"), path: Path, text: Type.String() }),
  /** Change the array at `path` like `Array.prototype.splice`. */
  Type.Object({
    op: Type.Literal("splice"),
    path: Path,
    index: Type.Integer({ minimum: 0 }),
    remove: Type.Integer({ minimum: 0 }),
    insert: Type.Array(Type.Unknown()),
  }),
]);
export type Op = Static<typeof Op>;

// The socket.

/** `"rooms"` or `"room:<id>"`. */
export const Target = Type.String({ pattern: "^(rooms|room:.+)$" });
export type Target = Static<typeof Target>;

export const ClientFrame = Type.Union([
  /** Must be first. */
  Type.Object({
    type: Type.Literal("hello"),
    protocol: Type.Literal(PROTOCOL_VERSION),
    token: Type.String(),
    client: Type.Object({ name: Type.String(), version: Type.String(), platform: Type.String() }),
  }),
  Type.Object({ type: Type.Literal("subscribe"), target: Target }),
  Type.Object({ type: Type.Literal("unsubscribe"), target: Target }),
  Type.Object({ type: Type.Literal("ping") }),
]);
export type ClientFrame = Static<typeof ClientFrame>;

export const ServerFrame = Type.Union([
  /** The reply to a good `hello`. A new `epoch` after reconnecting means subscribe again. */
  Type.Object({
    type: Type.Literal("welcome"),
    protocol: Type.Integer(),
    server: Type.Object({ version: Type.String() }),
    epoch: Type.String(),
    player: Player,
    clientId: Type.String(),
    heartbeatMs: Type.Integer(),
  }),
  /** The whole view, first after `subscribe`, with `seq` 0. */
  Type.Object({
    type: Type.Literal("snapshot"),
    target: Target,
    seq: Type.Integer({ minimum: 0 }),
    view: Type.Union([RoomView, RoomListView]),
  }),
  /** Changes since the previous frame for `target`; `seq` goes up by one. */
  Type.Object({
    type: Type.Literal("patch"),
    target: Target,
    seq: Type.Integer({ minimum: 0 }),
    ops: Type.Array(Op),
  }),
  Type.Object({
    type: Type.Literal("unsubscribed"),
    target: Target,
    reason: Type.Union([Type.Literal("not-found"), Type.Literal("removed")]),
  }),
  Type.Object({ type: Type.Literal("pong") }),
  /** A frame the server couldn't use; the socket stays open. */
  Type.Object({ type: Type.Literal("error"), message: Type.String() }),
]);
export type ServerFrame = Static<typeof ServerFrame>;

// HTTP: request and response bodies under `/v1/a/<assistant>`.

/**
 * What an error is, where a client acts on it rather than only showing `error`. A client reads a
 * code it doesn't know as no code.
 */
export const ERROR_CODE = {
  /** A 429 for asking too often: try again after `Retry-After` seconds, when given. */
  rateLimited: "rate_limited",
  /** A 429 for a message once the caller's or the assistant's monthly budget is spent. */
  budgetSpent: "budget_spent",
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export const ErrorResponse = Type.Object({
  error: Type.String(),
  /** One of `ERROR_CODE`, or one a later server adds. */
  code: Type.Optional(Type.String()),
});
export type ErrorResponse = Static<typeof ErrorResponse>;

export const AssistantsResponse = Type.Object({
  assistants: Type.Array(
    Type.Object({
      name: Type.String(),
      displayName: Type.String(),
      appearance: Type.Optional(Appearance),
    }),
  ),
});
export type AssistantsResponse = Static<typeof AssistantsResponse>;

export const ClientInfo = Type.Object({ name: Type.String(), platform: Type.String() });
export type ClientInfo = Static<typeof ClientInfo>;

export const PairRequest = Type.Object({ code: Type.String(), client: ClientInfo });
export type PairRequest = Static<typeof PairRequest>;

/** `token` is shown only here; keep it like a password. */
export const PairResponse = Type.Object({
  token: Type.String(),
  clientId: Type.String(),
  player: Player,
});
export type PairResponse = Static<typeof PairResponse>;

/** A browser asking at `POST /v1/sign-in` to be signed in by an app that already is. */
export const SignInResponse = Type.Object({
  /** What the app approves; in `link`, for anyone who sees the QR code. */
  id: Type.String(),
  /** Only for the browser, which shows it to the server to learn the answer; keep it secret. */
  secret: Type.String(),
  /** `nudge://sign-in?server=…&request=<id>`, for a QR code. */
  link: Type.String(),
  expiresAt: Type.Number(),
});
export type SignInResponse = Static<typeof SignInResponse>;

/** Until an app approves, `waiting`; then the assistant and a pairing code to `POST /pair` with. */
export const SignInStatusResponse = Type.Union([
  Type.Object({ status: Type.Literal("waiting") }),
  Type.Object({ status: Type.Literal("approved"), assistant: Type.String(), code: Type.String() }),
]);
export type SignInStatusResponse = Static<typeof SignInStatusResponse>;

export const MeResponse = Type.Object({
  player: Player,
  clientId: Type.String(),
  /** May use the `/admin` routes. */
  admin: Type.Boolean(),
});
export type MeResponse = Static<typeof MeResponse>;

/** The caller is always a member; `members` are other player ids. */
export const CreateRoomRequest = Type.Object({
  name: Type.String(),
  members: Type.Optional(Type.Array(Type.String())),
});
export type CreateRoomRequest = Static<typeof CreateRoomRequest>;

/** The room keeps its id. */
export const RenameRoomRequest = Type.Object({ name: Type.String() });
export type RenameRoomRequest = Static<typeof RenameRoomRequest>;

export const WhenBusy = Type.Union([
  Type.Literal("followUp"),
  Type.Literal("steer"),
  Type.Literal("reject"),
]);
export type WhenBusy = Static<typeof WhenBusy>;

export const MessageRequest = Type.Object({
  /** May be empty when the message has attachments. */
  text: Type.String(),
  /** Chosen by the client; sending the same one again is answered with the same submission. */
  requestId: Type.String(),
  /** What to do while the assistant is answering. Default `followUp`. */
  whenBusy: Type.Optional(WhenBusy),
  /** Only the sender sees the message and the answer to it; the room sees that there was one. */
  private: Type.Optional(Type.Boolean()),
  /** Ids of attachments the sender uploaded to the room and hasn't sent yet. */
  attachments: Type.Optional(
    Type.Array(Type.String(), { maxItems: ATTACHMENTS_PER_MESSAGE, uniqueItems: true }),
  ),
});
export type MessageRequest = Static<typeof MessageRequest>;

/** Whether the model gets the images attached in a room as they are (ADR 24). */
export const RoomImagesRequest = Type.Object({ allowed: Type.Boolean() });
export type RoomImagesRequest = Static<typeof RoomImagesRequest>;

export const MessageResponse = Type.Object({ submissionId: Type.Integer() });
export type MessageResponse = Static<typeof MessageResponse>;

export const TimelineResponse = Type.Object({
  /** Oldest first. */
  items: Type.Array(TimelineItem),
  /** Pass as `before` for the page before this one; absent at the start of the room. */
  before: Type.Optional(Type.String()),
});
export type TimelineResponse = Static<typeof TimelineResponse>;

export const RememberRequest = Type.Object({ text: Type.String() });
export type RememberRequest = Static<typeof RememberRequest>;

/** The caller's own memory: shown in their personal room, and in all their rooms when `shared`. */
export const PlayerMemoryResponse = Type.Object({
  facts: Type.Array(Fact),
  shared: Type.Boolean(),
});
export type PlayerMemoryResponse = Static<typeof PlayerMemoryResponse>;

export const ShareMemoryRequest = Type.Object({ shared: Type.Boolean() });
export type ShareMemoryRequest = Static<typeof ShareMemoryRequest>;

/** Which pushes a player gets; each kind is on unless `false`. */
export const NotificationPrefs = Type.Object({
  answers: Type.Optional(Type.Boolean()),
  approvals: Type.Optional(Type.Boolean()),
});
export type NotificationPrefs = Static<typeof NotificationPrefs>;

/** What a player says about themselves. Their home keeps it; other assistants are sent it. */
export const Profile = Type.Object({
  displayName: Type.String(),
  /** A `data:image/…;base64,` URL of at most 64 KiB. */
  avatar: Type.Optional(Type.String()),
  /** IANA, such as `Europe/Oslo`; the assistant's when absent. Times of the player's nudges. */
  timeZone: Type.Optional(Type.String()),
  /** BCP 47, such as `nb`: the assistant answers the player in it. */
  language: Type.Optional(Type.String()),
  notifications: Type.Optional(NotificationPrefs),
  /** Each extension's preferences for the player, by extension name. */
  extensions: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()))),
});
export type Profile = Static<typeof Profile>;

/** The fields to change; absent ones stay, `null` clears one. */
export const UpdateProfileRequest = Type.Object({
  displayName: Type.Optional(Type.String()),
  avatar: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  timeZone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  language: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notifications: Type.Optional(Type.Union([NotificationPrefs, Type.Null()])),
  /** By extension name: each one named is replaced, `null` clears it; `null` for all clears them all. */
  extensions: Type.Optional(
    Type.Union([
      Type.Record(
        Type.String(),
        Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
      ),
      Type.Null(),
    ]),
  ),
});
export type UpdateProfileRequest = Static<typeof UpdateProfileRequest>;

/**
 * A player's personal details, as they see them. Each value is theirs alone: the model and
 * everyone else only ever see its placeholder. Kept by the assistant they were given to; a home
 * doesn't send them on.
 */
export const PersonalDetails = Type.Object({
  fullName: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  address: Type.Optional(Type.String()),
  /** Where their device last said they were (`place (lat, lon)`), and when, in ms. */
  location: Type.Optional(Type.Object({ text: Type.String(), at: Type.Number() })),
  /** The shared rooms where they let the model know where they are. */
  locationRooms: Type.Optional(Type.Array(Type.String())),
});
export type PersonalDetails = Static<typeof PersonalDetails>;

/** Whether the model may know where the caller is in a shared room, for anyone there. */
export const ShareLocationRequest = Type.Object({ shared: Type.Boolean() });
export type ShareLocationRequest = Static<typeof ShareLocationRequest>;

/** Where a device is, and the place it named, such as a street address. */
export const LocationRequest = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  place: Type.Optional(Type.String({ maxLength: 200 })),
});
export type LocationRequest = Static<typeof LocationRequest>;

/** The details to change; absent ones stay, `null` or `""` clears one. */
export const UpdatePersonalRequest = Type.Object({
  fullName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  location: Type.Optional(Type.Union([LocationRequest, Type.Null()])),
});
export type UpdatePersonalRequest = Static<typeof UpdatePersonalRequest>;

/** An installed extension that takes settings from each player, for a profile's settings form. */
export const PlayerSettingsSchema = Type.Object({
  name: Type.String(),
  version: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  /** JSON Schema of what the player may choose, with the defaults of what they leave out. */
  schema: Type.Unknown(),
});
export type PlayerSettingsSchema = Static<typeof PlayerSettingsSchema>;

export const PlayerSettingsResponse = Type.Object({ extensions: Type.Array(PlayerSettingsSchema) });
export type PlayerSettingsResponse = Static<typeof PlayerSettingsResponse>;

/** A room's model context as its next request would send it, personal values as placeholders. */
export const ModelViewResponse = Type.Object({
  messages: Type.Array(
    Type.Object({
      role: Type.Union([
        Type.Literal("system"),
        Type.Literal("user"),
        Type.Literal("assistant"),
        Type.Literal("toolResult"),
      ]),
      text: Type.String(),
    }),
  ),
});
export type ModelViewResponse = Static<typeof ModelViewResponse>;

/** One month's model spend, in US dollars. */
export const MonthUsage = Type.Object({
  month: Type.String({ description: "YYYY-MM in the assistant's time zone" }),
  total: Type.Number(),
  /** By player id: what answering their messages cost. */
  players: Type.Record(Type.String(), Type.Number()),
  /** By room id. */
  rooms: Type.Record(Type.String(), Type.Number()),
});
export type MonthUsage = Static<typeof MonthUsage>;

/** The month's spend and limits; `months` (every room and player) for admins only. */
export const UsageResponse = Type.Object({
  month: Type.String(),
  total: Type.Number(),
  /** What answering the caller's messages cost this month. */
  mine: Type.Number(),
  budget: Type.Object({
    monthlyUsd: Type.Optional(Type.Number()),
    perPlayerUsd: Type.Optional(Type.Number()),
  }),
  months: Type.Optional(Type.Array(MonthUsage)),
});
export type UsageResponse = Static<typeof UsageResponse>;

/** The server's VAPID public key, for `PushManager.subscribe`'s `applicationServerKey`. */
export const PushKeyResponse = Type.Object({ publicKey: Type.String() });
export type PushKeyResponse = Static<typeof PushKeyResponse>;

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export const PushSubscribeRequest = Type.Object({
  endpoint: Type.String(),
  keys: Type.Object({ p256dh: Type.String(), auth: Type.String() }),
});
export type PushSubscribeRequest = Static<typeof PushSubscribeRequest>;

/**
 * A service worker's new subscription after `pushsubscriptionchange`, sent without a token: the
 * old subscription's endpoint and auth secret show it comes from the browser that had it.
 */
export const PushRenewRequest = Type.Object({
  old: Type.Object({ endpoint: Type.String(), auth: Type.String() }),
  subscription: PushSubscribeRequest,
});
export type PushRenewRequest = Static<typeof PushRenewRequest>;

/**
 * A phone or a Mac that takes native pushes: an APNs device token (hex) or an FCM registration
 * token. `sandbox` is for apps built for development, which APNs reaches through its sandbox.
 * Or, for apps whose push credentials the server doesn't have, a relay's handle for the device
 * and the device's X25519 key (32 bytes, base64url), which pushes are sealed for. `account` is
 * the app's own name for this sign-in, given back in every push, so an app signed in to several
 * assistants of the same name knows whose push it is.
 */
const PushAccount = Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }));
export const DeviceRequest = Type.Union([
  Type.Object({
    platform: Type.Union([Type.Literal("apns"), Type.Literal("fcm")]),
    token: Type.String({ minLength: 1, maxLength: 4096 }),
    environment: Type.Optional(Type.Union([Type.Literal("production"), Type.Literal("sandbox")])),
    account: PushAccount,
  }),
  Type.Object({
    platform: Type.Literal("relay"),
    relay: Type.String({ minLength: 1, maxLength: 2048 }),
    handle: Type.String({ minLength: 1, maxLength: 8192 }),
    deviceKey: Type.String({ minLength: 43, maxLength: 43 }),
    account: PushAccount,
  }),
]);
export type DeviceRequest = Static<typeof DeviceRequest>;

/**
 * Which native pushes this server can send; a platform it can't is `false`. `relays` lists the
 * push relays it sends through.
 */
export const DevicesResponse = Type.Object({
  apns: Type.Boolean(),
  fcm: Type.Boolean(),
  relays: Type.Optional(Type.Array(Type.String())),
});
export type DevicesResponse = Static<typeof DevicesResponse>;

/** A circle a phone watches for the places extension (ADR 18), entering and leaving. */
export const ArrivalRegion = Type.Object({
  /** `p:<name>` for a saved place, `k:<id>` for a place of a kind. */
  id: Type.String(),
  latitude: Type.Number(),
  longitude: Type.Number(),
  /** Metres. */
  radius: Type.Number(),
});
export type ArrivalRegion = Static<typeof ArrivalRegion>;

/**
 * `GET /ext/places/regions?lat=&lon=`: what the phone watches. Leaving `refresh` means asking
 * again from where it is then; `version` goes up when the list changes.
 */
export const ArrivalRegionsResponse = Type.Object({
  version: Type.Number(),
  regions: Type.Array(ArrivalRegion),
  refresh: Type.Optional(
    Type.Object({ latitude: Type.Number(), longitude: Type.Number(), radius: Type.Number() }),
  ),
});
export type ArrivalRegionsResponse = Static<typeof ArrivalRegionsResponse>;

/** `POST /ext/places/events`: the phone got to or left a region. */
export const RegionEventRequest = Type.Object({
  regionId: Type.String(),
  event: Type.Union([Type.Literal("enter"), Type.Literal("exit")]),
});
export type RegionEventRequest = Static<typeof RegionEventRequest>;

/** How many reminders the event set off. */
export const RegionEventResponse = Type.Object({ fired: Type.Number() });
export type RegionEventResponse = Static<typeof RegionEventResponse>;

/** `GET /ext/places/places`: the caller's saved places and arrival reminders, values readable. */
export const PlacesResponse = Type.Object({
  places: Type.Array(
    Type.Object({
      name: Type.String(),
      placeholder: Type.String(),
      address: Type.String(),
      radius: Type.Number(),
    }),
  ),
  reminders: Type.Array(
    Type.Object({
      id: Type.String(),
      roomId: Type.String(),
      on: Type.Union([Type.Literal("arrive"), Type.Literal("leave")]),
      repeat: Type.Union([Type.Literal("once"), Type.Literal("always")]),
      /** A saved place's name, or `kind` for any place of a kind, such as "grocery store". */
      place: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      message: Type.String(),
    }),
  ),
});
export type PlacesResponse = Static<typeof PlacesResponse>;

/** An assistant by its server and its name there, such as one to join. */
export const PlaceRequest = Type.Object({ server: Type.String(), assistant: Type.String() });
export type PlaceRequest = Static<typeof PlaceRequest>;

/** An assistant the caller joined from here, their home; `carryMemory` once they allowed it. */
export const Membership = Type.Object({
  server: Type.String(),
  assistant: Type.String(),
  since: Type.Number(),
  carryMemory: Type.Boolean(),
});
export type Membership = Static<typeof Membership>;

/** `address` is the caller's, such as `vegard@nudge.example.com/robin`, for admins elsewhere. */
export const MembershipsResponse = Type.Object({
  address: Type.String(),
  memberships: Type.Array(Membership),
});
export type MembershipsResponse = Static<typeof MembershipsResponse>;

export const CarryMemoryRequest = Type.Object({
  server: Type.String(),
  assistant: Type.String(),
  carry: Type.Boolean(),
});
export type CarryMemoryRequest = Static<typeof CarryMemoryRequest>;

/** Signed by one assistant and encrypted for another; clients only pass it on. */
export const Sealed = Type.Object({
  v: Type.Literal(1),
  epk: Type.String(),
  iv: Type.String(),
  data: Type.String(),
  tag: Type.String(),
});
export type Sealed = Static<typeof Sealed>;

/** The caller's home vouching for them, for the assistant they asked about only. */
export const AssertResponse = Type.Object({ assertion: Sealed });
export type AssertResponse = Static<typeof AssertResponse>;

/** Answered like `POST /pair`: a token for the player there, `address` the caller's home. */
export const JoinRequest = Type.Object({ assertion: Sealed });
export type JoinRequest = Static<typeof JoinRequest>;

/** A server, by its address: one the caller owns, or one to vouch for them to. */
export const ServerRequest = Type.Object({ server: Type.String() });
export type ServerRequest = Static<typeof ServerRequest>;

/** A server the caller owns, kept at their home so all their devices see it (ADR 11). */
export const OwnedServer = Type.Object({
  server: Type.String(),
  since: Type.Number(),
});
export type OwnedServer = Static<typeof OwnedServer>;

export const OwnedServersResponse = Type.Object({ servers: Type.Array(OwnedServer) });
export type OwnedServersResponse = Static<typeof OwnedServersResponse>;

export const InviteRequest = Type.Object({ address: Type.String() });
export type InviteRequest = Static<typeof InviteRequest>;

/** Someone an admin asked to join, by their address; good for a week. */
export const Invite = Type.Object({
  id: Type.String(),
  address: Type.String(),
  /** The admin's player id. */
  by: Type.String(),
  createdAt: Type.Number(),
  expiresAt: Type.Number(),
});
export type Invite = Static<typeof Invite>;

/** `link` is `nudge://join?server=…&assistant=…`, for the invited person's app. */
export const InviteResponse = Type.Object({ invite: Invite, link: Type.String() });
export type InviteResponse = Static<typeof InviteResponse>;

export const InvitesResponse = Type.Object({ invites: Type.Array(Invite) });
export type InvitesResponse = Static<typeof InvitesResponse>;

export const DecideRequest = Type.Object({ approve: Type.Boolean() });
export type DecideRequest = Static<typeof DecideRequest>;

/** An installed extension as one room has it. The built-in one is always on and not listed. */
export const RoomExtension = Type.Object({
  name: Type.String(),
  version: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  /** Whether the room's conversation uses it. */
  enabled: Type.Boolean(),
  /** Whether it is on in rooms of this kind by default; `enabled` differs when the room chose. */
  byDefault: Type.Boolean(),
  /** Why it failed to start; it is off, in every room, until it does. */
  error: Type.Optional(Type.String()),
});
export type RoomExtension = Static<typeof RoomExtension>;

export const RoomExtensionsResponse = Type.Object({ extensions: Type.Array(RoomExtension) });
export type RoomExtensionsResponse = Static<typeof RoomExtensionsResponse>;

/** `null` goes back to the default for the room's kind. */
export const SetRoomExtensionRequest = Type.Object({
  enabled: Type.Union([Type.Boolean(), Type.Null()]),
});
export type SetRoomExtensionRequest = Static<typeof SetRoomExtensionRequest>;

const RoomKinds = Type.Array(
  Type.Union([Type.Literal("lobby"), Type.Literal("personal"), Type.Literal("shared")]),
  { uniqueItems: true },
);

/** An extension on the admin's settings page: from the config, or found beside it. */
export const ExtensionSetup = Type.Object({
  /** As the config writes it; sent back to say which one. */
  from: Type.String(),
  /** Absent when the module could not be loaded. */
  name: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  /** In the config; false for one found in `extensions/` that nobody added yet. */
  configured: Type.Boolean(),
  /** Installed: configured and not turned off. */
  enabled: Type.Boolean(),
  /** The kinds of room it is on in by default; absent for every kind. */
  rooms: Type.Optional(RoomKinds),
  settings: Type.Record(Type.String(), Type.Unknown()),
  /** Its settings as JSON Schema; absent when it takes none. */
  schema: Type.Optional(Type.Unknown()),
  /** `${NAME}` references in its settings that the server's environment doesn't set. */
  missingEnv: Type.Array(Type.String()),
  /** Why the module could not be loaded. */
  error: Type.Optional(Type.String()),
  /** Why its setup threw when the assistant opened; it is left out until it starts. */
  failed: Type.Optional(Type.String()),
});
export type ExtensionSetup = Static<typeof ExtensionSetup>;

export const ExtensionSetupsResponse = Type.Object({ extensions: Type.Array(ExtensionSetup) });
export type ExtensionSetupsResponse = Static<typeof ExtensionSetupsResponse>;

/** The assistant's extensions, in the order they are installed; ones left out are removed. */
export const SaveExtensionSetupsRequest = Type.Object({
  extensions: Type.Array(
    Type.Object({
      from: Type.String(),
      enabled: Type.Boolean(),
      settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      rooms: Type.Optional(RoomKinds),
    }),
  ),
});
export type SaveExtensionSetupsRequest = Static<typeof SaveExtensionSetupsRequest>;

export const ProtectRequest = Type.Object({
  value: Type.String(),
  /** Upper-case letters, such as `NAME`; default `PRIVATE`. */
  kind: Type.Optional(Type.String({ pattern: "^[A-Z]+$" })),
  /** Also hide the value from everyone but the caller, wherever it shows. */
  private: Type.Optional(Type.Boolean()),
});
export type ProtectRequest = Static<typeof ProtectRequest>;

export const ProtectResponse = Type.Object({ placeholder: Type.String() });
export type ProtectResponse = Static<typeof ProtectResponse>;

/** A value only its owner sees; others see `placeholder`. */
export const PrivateValue = Type.Object({
  placeholder: Type.String(),
  kind: Type.String(),
  value: Type.String(),
});
export type PrivateValue = Static<typeof PrivateValue>;

/** The caller's private values, in the order they were made private. */
export const PrivateValuesResponse = Type.Object({ values: Type.Array(PrivateValue) });
export type PrivateValuesResponse = Static<typeof PrivateValuesResponse>;

export const CreatePlayerRequest = Type.Object({ displayName: Type.String() });
export type CreatePlayerRequest = Static<typeof CreatePlayerRequest>;

export const PlayerResponse = Type.Object({ player: Player });
export type PlayerResponse = Static<typeof PlayerResponse>;

export const PairingCodeRequest = Type.Object({ playerId: Type.String() });
export type PairingCodeRequest = Static<typeof PairingCodeRequest>;

export const PairingCodeResponse = Type.Object({
  code: Type.String(),
  /** `nudge://pair?server=…&assistant=…&code=…`, for a link or a QR code. */
  link: Type.String(),
  expiresAt: Type.Number(),
});
export type PairingCodeResponse = Static<typeof PairingCodeResponse>;

export const TokenInfo = Type.Object({
  clientId: Type.String(),
  playerId: Type.String(),
  createdAt: Type.Number(),
  /** What the client said it is when it paired. */
  client: Type.Optional(ClientInfo),
  /** When it last signed in a request or socket, to the minute; absent until then. */
  lastUsedAt: Type.Optional(Type.Number()),
  /** When it stops working; absent for one that works until revoked, as apps' do. */
  expiresAt: Type.Optional(Type.Number()),
});
export type TokenInfo = Static<typeof TokenInfo>;

export const TokensResponse = Type.Object({ tokens: Type.Array(TokenInfo) });
export type TokensResponse = Static<typeof TokensResponse>;

export const AdminPlayer = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  /** May use the `/admin` routes. */
  admin: Type.Boolean(),
});
export type AdminPlayer = Static<typeof AdminPlayer>;

export const PlayersResponse = Type.Object({ players: Type.Array(AdminPlayer) });

/** `null` goes back to the app icon's robot. */
export const SetAppearanceRequest = Type.Object({
  appearance: Type.Union([Appearance, Type.Null()]),
});
export type SetAppearanceRequest = Static<typeof SetAppearanceRequest>;

export const AppearanceResponse = Type.Object({ appearance: Type.Optional(Appearance) });
export type AppearanceResponse = Static<typeof AppearanceResponse>;
export type PlayersResponse = Static<typeof PlayersResponse>;

export const SetAdminRequest = Type.Object({ admin: Type.Boolean() });
export type SetAdminRequest = Static<typeof SetAdminRequest>;

/** A new token for an existing player; like `PairResponse`, the token is shown only here. */
export const IssueTokenRequest = Type.Object({
  playerId: Type.String(),
  /** When it stops working, such as for a script's; absent, it works until revoked. */
  expiresAt: Type.Optional(Type.Number()),
});
export type IssueTokenRequest = Static<typeof IssueTokenRequest>;

export const RoomsResponse = Type.Object({ rooms: Type.Array(Room) });
export type RoomsResponse = Static<typeof RoomsResponse>;

/** Unlike `POST /rooms`, the caller is not added: `members` are all the room's player ids. */
export const AdminCreateRoomRequest = Type.Object({
  name: Type.String(),
  members: Type.Array(Type.String()),
});
export type AdminCreateRoomRequest = Static<typeof AdminCreateRoomRequest>;

/** Every room's pending nudges, soonest first. */
export const NudgesResponse = Type.Object({ nudges: Type.Array(RoomListNudge) });
export type NudgesResponse = Static<typeof NudgesResponse>;

/** Socket close codes, after HTTP status codes. */
export const CLOSE = {
  badRequest: 4400,
  unauthorized: 4401,
  notFound: 4404,
  /** The host is shutting down. */
  goingAway: 1001,
} as const;

// The server's own API, under `/v1/server` (ADR 11): for its owners, not an assistant's admins.

export const ModelChoice = Type.Object({ provider: Type.String(), modelId: Type.String() });
export type ModelChoice = Static<typeof ModelChoice>;

export const AssistantBudget = Type.Object({
  monthlyUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  perPlayerUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  warnAt: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  /** Without `monthlyUsd`, admins hear once a month when spend reaches it; default 25. */
  warnUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});
export type AssistantBudget = Static<typeof AssistantBudget>;

/** One of the server's assistants, with its settings. */
export const ServerAssistant = Type.Object({
  /** In its URLs and its people's addresses; it never changes. */
  name: Type.String(),
  displayName: Type.String(),
  model: ModelChoice,
  timeZone: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  budget: Type.Optional(AssistantBudget),
  /** False when it is in the config but failed to open. */
  running: Type.Boolean(),
});
export type ServerAssistant = Static<typeof ServerAssistant>;

export const ServerAssistantsResponse = Type.Object({ assistants: Type.Array(ServerAssistant) });
export type ServerAssistantsResponse = Static<typeof ServerAssistantsResponse>;

export const CreateAssistantRequest = Type.Object({
  name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 40 }),
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(ModelChoice),
  timeZone: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  budget: Type.Optional(AssistantBudget),
  /** Someone whose home it is to be: made its first player, so its admin, with a pairing code. */
  firstPlayer: Type.Optional(Type.Object({ displayName: Type.String({ minLength: 1 }) })),
  /**
   * An address to invite, such as the owner's own for an assistant that is "for me": their app
   * then joins it from home, and as its first player they are its admin. Needs federation, which
   * a new assistant has when the server has a public address.
   */
  invite: Type.Optional(Type.String()),
});
export type CreateAssistantRequest = Static<typeof CreateAssistantRequest>;

export const CreateAssistantResponse = Type.Object({
  assistant: ServerAssistant,
  /** For `firstPlayer`: the code they pair their app with. */
  pairing: Type.Optional(
    Type.Intersect([PairingCodeResponse, Type.Object({ playerId: Type.String() })]),
  ),
  /** For `invite`: the link that joins, `nudge://join?server=…&assistant=…`. */
  joinLink: Type.Optional(Type.String()),
});
export type CreateAssistantResponse = Static<typeof CreateAssistantResponse>;

/** Someone to invite to an assistant by their address, as an owner. */
export const InviteToAssistantRequest = Type.Object({ address: Type.String() });
export type InviteToAssistantRequest = Static<typeof InviteToAssistantRequest>;

export const InviteToAssistantResponse = Type.Object({
  /** `nudge://join?server=…&assistant=…`, which their app joins with from home. */
  joinLink: Type.String(),
});
export type InviteToAssistantResponse = Static<typeof InviteToAssistantResponse>;

/** A value sets the setting, `null` goes back to the default; absent leaves it. */
export const UpdateAssistantRequest = Type.Object({
  displayName: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  model: Type.Optional(Type.Union([ModelChoice, Type.Null()])),
  timeZone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  instructions: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  budget: Type.Optional(Type.Union([AssistantBudget, Type.Null()])),
});
export type UpdateAssistantRequest = Static<typeof UpdateAssistantRequest>;

export const DeleteAssistantResponse = Type.Object({
  /** The backup made before it went, in the server's `server/deleted`. */
  backup: Type.String(),
});
export type DeleteAssistantResponse = Static<typeof DeleteAssistantResponse>;

/** Where an assistant's key for a model provider comes from; the key itself is never shown. */
export const ProviderKey = Type.Object({
  provider: Type.String(),
  /** `env`: the server's environment, which wins; `none`: no key. */
  source: Type.Union([
    Type.Literal("env"),
    Type.Literal("server"),
    Type.Literal("assistant"),
    Type.Literal("none"),
  ]),
  /** For `env`: which variables. */
  variables: Type.Optional(Type.Array(Type.String())),
});
export type ProviderKey = Static<typeof ProviderKey>;

export const ProviderKeysResponse = Type.Object({ keys: Type.Array(ProviderKey) });
export type ProviderKeysResponse = Static<typeof ProviderKeysResponse>;

export const SetProviderKeyRequest = Type.Object({
  key: Type.String({ minLength: 1 }),
  /** For one assistant only; default every assistant on the server. */
  assistant: Type.Optional(Type.String()),
  /** Send one tiny request with it first, and refuse it if that fails; default true. */
  test: Type.Optional(Type.Boolean()),
});
export type SetProviderKeyRequest = Static<typeof SetProviderKeyRequest>;

/**
 * Someone who runs the server: a person who lives on one of its assistants (`assistant` and
 * `playerId`), or a person whose home is elsewhere (`address`), who signs in vouched for by it.
 */
export const ServerOwner = Type.Object({
  id: Type.String(),
  assistant: Type.Optional(Type.String()),
  playerId: Type.Optional(Type.String()),
  address: Type.Optional(Type.String()),
  addedAt: Type.Number(),
});
export type ServerOwner = Static<typeof ServerOwner>;

export const ServerOwnersResponse = Type.Object({ owners: Type.Array(ServerOwner) });
export type ServerOwnersResponse = Static<typeof ServerOwnersResponse>;

/** A player of one of the server's assistants (`assistant` and `playerId`), or an `address`. */
export const AddOwnerRequest = Type.Object({
  assistant: Type.Optional(Type.String()),
  playerId: Type.Optional(Type.String()),
  /** Makes the player an admin of `assistant` too. */
  admin: Type.Optional(Type.Boolean()),
  address: Type.Optional(Type.String()),
});
export type AddOwnerRequest = Static<typeof AddOwnerRequest>;

/**
 * An owner's server token for this client. Sent with the token of the owner's player of
 * `assistant`, or with `assertion` alone: their home vouching for them to this server, from the
 * home's `POST /ext/federation/owner-assertion`.
 */
export const ServerSessionRequest = Type.Object({
  assistant: Type.Optional(Type.String()),
  client: ClientInfo,
  assertion: Type.Optional(Sealed),
});
export type ServerSessionRequest = Static<typeof ServerSessionRequest>;

/** The server's own keys, as homes seal owner assertions to it (ADR 11). */
export const ServerKeyResponse = Type.Object({
  signingKey: Type.String(),
  encryptionKey: Type.String(),
});
export type ServerKeyResponse = Static<typeof ServerKeyResponse>;

/** `token` is shown only here; keep it like a password. */
export const ServerSessionResponse = Type.Object({
  token: Type.String(),
  clientId: Type.String(),
  owner: ServerOwner,
});
export type ServerSessionResponse = Static<typeof ServerSessionResponse>;

export const UpdateState = Type.Object({
  /** The version running. */
  current: Type.String(),
  /** Whether the server installs new releases itself; false when an owner paused it. */
  automatic: Type.Boolean(),
  /** A newer release the project signed, not installed yet. */
  available: Type.Optional(Type.String()),
  checkedAt: Type.Optional(Type.Number()),
  /** Why the last check failed. */
  error: Type.Optional(Type.String()),
});
export type UpdateState = Static<typeof UpdateState>;

export const SetUpdatesRequest = Type.Object({ automatic: Type.Boolean() });
export type SetUpdatesRequest = Static<typeof SetUpdatesRequest>;

/** One region of the server's map: picked by an owner, or fetched because someone was there. */
export const GeoRegionStatus = Type.Object({
  /** Geofabrik's id, such as `norway`, `us/california` or `bayern`. */
  id: Type.String(),
  name: Type.String(),
  /** Only regions fetched for someone are dropped to make room, the longest unused first. */
  by: Type.Union([Type.Literal("owner"), Type.Literal("follow")]),
  state: Type.Union([
    Type.Literal("waiting"),
    Type.Literal("downloading"),
    Type.Literal("importing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
  ]),
  step: Type.Optional(Type.String()),
  /** Of the current download, from 0 to 1. */
  progress: Type.Optional(Type.Number()),
  bytes: Type.Optional(Type.Number()),
  /** When its data was fetched; it is fetched again once a month. */
  updatedAt: Type.Optional(Type.Number()),
  /** When someone was last there. */
  usedAt: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});
export type GeoRegionStatus = Static<typeof GeoRegionStatus>;

/**
 * The server's own map (ADR 18): addresses, places and routes from OpenStreetMap, for regions
 * anywhere in the world, served on the server itself so nothing about where people go leaves it.
 */
export const GeoStatus = Type.Object({
  state: Type.Union([
    Type.Literal("off"),
    Type.Literal("working"),
    Type.Literal("ready"),
    Type.Literal("failed"),
  ]),
  /** Whether it fetches the region someone's phone says they are in. */
  follow: Type.Boolean(),
  /** Most the regions may take on disk; those fetched for someone make room, oldest use first. */
  limitGb: Type.Number(),
  usedBytes: Type.Number(),
  regions: Type.Array(GeoRegionStatus),
  error: Type.Optional(Type.String()),
});
export type GeoStatus = Static<typeof GeoStatus>;

/** What changes: the regions owners want (the whole list), following people, the disk limit. */
export const SetGeoRequest = Type.Object({
  regions: Type.Optional(Type.Array(Type.String())),
  follow: Type.Optional(Type.Boolean()),
  limitGb: Type.Optional(Type.Number({ minimum: 1 })),
});
export type SetGeoRequest = Static<typeof SetGeoRequest>;

/** Every region the map can hold, for owners to pick from. */
export const GeoRegionsResponse = Type.Object({
  regions: Type.Array(
    Type.Object({ id: Type.String(), name: Type.String(), parent: Type.Optional(Type.String()) }),
  ),
});
export type GeoRegionsResponse = Static<typeof GeoRegionsResponse>;

/**
 * The server's Wired: an encrypted network between Nudge servers that needs no open port at
 * home. Other servers reach this one's API at `http://nudge.<name>.wired`.
 */
export const WiredState = Type.Object({
  /**
   * `unavailable`: this release has no Wired; `root`: this server holds the network; `member`:
   * it joined one.
   */
  state: Type.Union([
    Type.Literal("off"),
    Type.Literal("unavailable"),
    Type.Literal("starting"),
    Type.Literal("root"),
    Type.Literal("member"),
    Type.Literal("error"),
  ]),
  /**
   * Its name in the network: others reach it at `http://nudge.<name>.wired`. While off, the name
   * it takes when turned on or joining, unless the owner picks another.
   */
  name: Type.Optional(Type.String()),
  members: Type.Optional(Type.Array(Type.Object({ name: Type.String(), anchor: Type.Boolean() }))),
  /** The network's relays: public addresses of servers every server reaches the others through. */
  relays: Type.Optional(Type.Array(Type.String())),
  /** The relay this server serves, at its public address. */
  relay: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
export type WiredState = Static<typeof WiredState>;

/**
 * A server's name in a Wired network, such as `box`: 1–63 lowercase letters, digits and dashes,
 * starting and ending with a letter or digit. Absent, it is the public address's first label, or
 * the host's name.
 */
export const WiredName = Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" });

/** Makes the server the root of its own network, as `name` when given. The body may be empty. */
export const WiredEnableRequest = Type.Object({ name: Type.Optional(WiredName) });
export type WiredEnableRequest = Static<typeof WiredEnableRequest>;

/** A relay a new server will serve, such as `https://robin.exe.xyz`, added before it joins. */
export const WiredRelayRequest = Type.Object({ url: Type.String({ pattern: "^https://" }) });
export type WiredRelayRequest = Static<typeof WiredRelayRequest>;

/**
 * Joins the network `invite` is for, as `name` when given. The server serves a relay at its
 * public HTTPS address, or `relayUrl`, which the root must have listed first
 * (`POST /server/wired/relays` there).
 */
export const WiredJoinRequest = Type.Object({
  invite: Type.String({ pattern: "^wired1[a-z0-9]+$" }),
  relayUrl: Type.Optional(Type.String({ pattern: "^https://" })),
  /** Its name in the network; see `WiredName`. */
  name: Type.Optional(WiredName),
});
export type WiredJoinRequest = Static<typeof WiredJoinRequest>;

/** The invite the new server joins with, in `NUDGE_WIRED_INVITE`. It is a credential. */
export const WiredRelayResponse = Type.Object({ invite: Type.String() });
export type WiredRelayResponse = Static<typeof WiredRelayResponse>;

/**
 * A model request that failed, as owners see it: the provider's answer with placeholders where
 * personal values were, scrubbed of keys and cut short.
 */
export const ModelErrorShown = Type.Object({
  /** When, in ms since the epoch. */
  at: Type.Number(),
  /** The assistant's URL name, when the request was one of theirs. */
  assistant: Type.Optional(Type.String()),
  provider: Type.String(),
  model: Type.String(),
  message: Type.String(),
});
export type ModelErrorShown = Static<typeof ModelErrorShown>;

export const ServerInfoResponse = Type.Object({
  version: Type.String(),
  /** The owner whose token asked. */
  owner: ServerOwner,
  assistants: Type.Array(ServerAssistant),
  /** Absent for a server that can't update itself, such as one run from a checkout. */
  updates: Type.Optional(UpdateState),
  /** The last model requests that failed, newest first; absent where the server keeps none. */
  errors: Type.Optional(Type.Array(ModelErrorShown)),
});
export type ServerInfoResponse = Static<typeof ServerInfoResponse>;

/**
 * `GET /v1/health`, without a token: whether the server is up, for a load balancer or a monitor.
 * It names nothing, so it tells a stranger no more than that a Nudge server is there.
 */
export const HealthResponse = Type.Object({
  ok: Type.Literal(true),
  /** How many assistants are open. */
  assistants: Type.Integer({ minimum: 0 }),
  /** Seconds since a model request last failed; absent when none has since the server started. */
  lastModelErrorAgeSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type HealthResponse = Static<typeof HealthResponse>;

// Setting a server up, under `/v1/setup` (ADR 11): open only while it has no config.

export const SetupProvider = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** The models setup offers, best first; `recommended` is the one to preselect. */
  models: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
  recommended: Type.String(),
});
export type SetupProvider = Static<typeof SetupProvider>;

/** A model server found on the machine, such as Ollama, that needs no key. */
export const SetupLocalServer = Type.Object({
  id: Type.String(),
  name: Type.String(),
  baseUrl: Type.String(),
  models: Type.Array(Type.String()),
});
export type SetupLocalServer = Static<typeof SetupLocalServer>;

export const SetupInfoResponse = Type.Object({
  /** False once the server is set up, or after too many wrong codes until it restarts. */
  open: Type.Boolean(),
  providers: Type.Array(SetupProvider),
  local: Type.Array(SetupLocalServer),
});
export type SetupInfoResponse = Static<typeof SetupInfoResponse>;

export const SetupCodeRequest = Type.Object({ code: Type.String() });
export type SetupCodeRequest = Static<typeof SetupCodeRequest>;

export const SetupKeyRequest = Type.Object({
  code: Type.String(),
  provider: Type.String(),
  key: Type.String({ minLength: 1 }),
});
export type SetupKeyRequest = Static<typeof SetupKeyRequest>;

export const SetupRequest = Type.Object({
  code: Type.String(),
  client: ClientInfo,
  assistant: Type.Object({
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 40 }),
    displayName: Type.Optional(Type.String({ minLength: 1 })),
  }),
  model: ModelChoice,
  /** The provider's key, tested again before it is kept. */
  key: Type.Optional(Type.String({ minLength: 1 })),
  /** The id of a found local server `model` is on, instead of a key. */
  local: Type.Optional(Type.String()),
  you: Type.Object({ displayName: Type.String({ minLength: 1 }) }),
  /** The address the browser reached the server at, kept for pairing links and other assistants. */
  publicUrl: Type.Optional(Type.String({ pattern: "^https?://" })),
  /** Nightly backups beside the config; default true. */
  backups: Type.Optional(Type.Boolean()),
  /**
   * Whether its assistant has federation, so people can join it from their homes and it can be
   * part of a cluster; default true, when it has a public address. False sets it up standalone.
   */
  federation: Type.Optional(Type.Boolean()),
  /**
   * An owner assertion from the person's home (its `POST /ext/federation/owner-assertion`), when
   * they set it up signed in there: the server is started from that home, so its first player is
   * them and its owner their address, and it can join their cluster later. Without one, the first
   * player lives here, a new home.
   */
  home: Type.Optional(Sealed),
});
export type SetupRequest = Static<typeof SetupRequest>;

/** The tokens are shown only here: the player's for the assistant, the owner's for the server. */
export const SetupResponse = Type.Object({
  assistant: Type.String(),
  player: Player,
  token: Type.String(),
  clientId: Type.String(),
  serverToken: Type.String(),
  owner: ServerOwner,
});
export type SetupResponse = Static<typeof SetupResponse>;

export const RecoveryKitRequest = Type.Object({ passphrase: Type.String({ minLength: 8 }) });
export type RecoveryKitRequest = Static<typeof RecoveryKitRequest>;

/** The kit as a file to save: the backup key, sealed with the passphrase. */
export const RecoveryKitResponse = Type.Object({ kit: Type.String() });
export type RecoveryKitResponse = Static<typeof RecoveryKitResponse>;

const S3Target = {
  type: Type.Literal("s3"),
  /** Such as https://s3.eu-north-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com. */
  endpoint: Type.String({ pattern: "^https?://" }),
  bucket: Type.String({ minLength: 1 }),
  /** Default the one in an AWS endpoint, else us-east-1. */
  region: Type.Optional(Type.String({ minLength: 1 })),
  /** A folder in the bucket, such as `nudge/`. */
  prefix: Type.Optional(Type.String()),
  /** Bucket in the path rather than the host name; default on, except for AWS. */
  pathStyle: Type.Optional(Type.Boolean()),
};
const WebDavTarget = {
  type: Type.Literal("webdav"),
  /** The folder, such as https://cloud.example/remote.php/dav/files/me/nudge/. */
  url: Type.String({ pattern: "^https?://" }),
};

/** Where backups are copied off the server (ADR 8): an S3-compatible bucket or a WebDAV folder. */
export const BackupRemoteTarget = Type.Union([Type.Object(S3Target), Type.Object(WebDavTarget)]);
export type BackupRemoteTarget = Static<typeof BackupRemoteTarget>;

/** The server's backups: where, how often, how many, and how the last upload went. */
export const BackupState = Type.Object({
  /** Whether the server makes backups on its own; the rest is its defaults when it doesn't. */
  on: Type.Boolean(),
  /** The folder on the server they go to. */
  dir: Type.Optional(Type.String()),
  everyHours: Type.Number(),
  /** Backups kept, in the folder and on the remote alike. */
  keep: Type.Number(),
  /** When the newest in the folder was made. */
  lastBackupAt: Type.Optional(Type.Number()),
  remote: Type.Optional(BackupRemoteTarget),
  /** The access key id or user name the remote is reached with, and where it is set. */
  credentials: Type.Optional(
    Type.Object({
      user: Type.String(),
      from: Type.Union([Type.Literal("env"), Type.Literal("server")]),
    }),
  ),
  lastUploadAt: Type.Optional(Type.Number()),
  /** Why the last upload failed, when it did, and when. */
  lastError: Type.Optional(Type.String()),
  lastErrorAt: Type.Optional(Type.Number()),
});
export type BackupState = Static<typeof BackupState>;

/**
 * A remote target for backups, with what to sign in with: an access key id and secret for S3, a
 * user name and password for WebDAV. Without them the kept ones stay. The server first writes,
 * lists and deletes a small file there, unless `test` is false.
 */
const RemoteCredentialFields = {
  user: Type.Optional(Type.String()),
  secret: Type.Optional(Type.String()),
  test: Type.Optional(Type.Boolean()),
};
export const SetBackupRemoteRequest = Type.Union([
  Type.Object({ ...S3Target, ...RemoteCredentialFields }),
  Type.Object({ ...WebDavTarget, ...RemoteCredentialFields }),
]);
export type SetBackupRemoteRequest = Static<typeof SetBackupRemoteRequest>;

/** A backup made now: its file name, and why the upload failed if it did. */
export const BackupNowResponse = Type.Object({
  file: Type.String(),
  uploadError: Type.Optional(Type.String()),
});
export type BackupNowResponse = Static<typeof BackupNowResponse>;

/** Every named schema, for `schema/v1.json`. */
export const SCHEMAS = {
  Player,
  RoomKind,
  Room,
  ApprovalStatus,
  ToolPart,
  Part,
  TimelineItem,
  Status,
  QueuedMessage,
  Approval,
  Fact,
  RoomNudge,
  RoomView,
  RoomListEntry,
  RoomListNudge,
  Appearance,
  RoomListView,
  Path,
  Op,
  Target,
  ClientFrame,
  ServerFrame,
  ErrorResponse,
  AssistantsResponse,
  ClientInfo,
  PairRequest,
  PairResponse,
  SignInResponse,
  SignInStatusResponse,
  MeResponse,
  CreateRoomRequest,
  RenameRoomRequest,
  WhenBusy,
  MessageRequest,
  MessageResponse,
  TimelineResponse,
  RememberRequest,
  PlayerMemoryResponse,
  ShareMemoryRequest,
  NotificationPrefs,
  Profile,
  UpdateProfileRequest,
  PersonalDetails,
  LocationRequest,
  UpdatePersonalRequest,
  ShareLocationRequest,
  PlayerSettingsSchema,
  PlayerSettingsResponse,
  PushKeyResponse,
  PushSubscribeRequest,
  PushRenewRequest,
  DeviceRequest,
  DevicesResponse,
  ArrivalRegion,
  ArrivalRegionsResponse,
  RegionEventRequest,
  RegionEventResponse,
  PlacesResponse,
  PlaceRequest,
  Membership,
  MembershipsResponse,
  CarryMemoryRequest,
  Sealed,
  AssertResponse,
  JoinRequest,
  ServerRequest,
  OwnedServer,
  OwnedServersResponse,
  InviteRequest,
  Invite,
  InviteResponse,
  InvitesResponse,
  ModelViewResponse,
  MonthUsage,
  UsageResponse,
  DecideRequest,
  RoomExtension,
  RoomExtensionsResponse,
  SetRoomExtensionRequest,
  ExtensionSetup,
  ExtensionSetupsResponse,
  SaveExtensionSetupsRequest,
  ProtectRequest,
  ProtectResponse,
  PrivateValue,
  PrivateValuesResponse,
  CreatePlayerRequest,
  PlayerResponse,
  PairingCodeRequest,
  PairingCodeResponse,
  TokenInfo,
  TokensResponse,
  AdminPlayer,
  PlayersResponse,
  SetAppearanceRequest,
  AppearanceResponse,
  SetAdminRequest,
  IssueTokenRequest,
  RoomsResponse,
  AdminCreateRoomRequest,
  NudgesResponse,
  ModelChoice,
  AssistantBudget,
  ServerAssistant,
  ServerAssistantsResponse,
  CreateAssistantRequest,
  CreateAssistantResponse,
  InviteToAssistantRequest,
  InviteToAssistantResponse,
  UpdateAssistantRequest,
  DeleteAssistantResponse,
  ProviderKey,
  ProviderKeysResponse,
  SetProviderKeyRequest,
  ServerOwner,
  ServerOwnersResponse,
  AddOwnerRequest,
  ServerSessionRequest,
  ServerKeyResponse,
  ServerSessionResponse,
  UpdateState,
  SetUpdatesRequest,
  GeoRegionStatus,
  GeoStatus,
  SetGeoRequest,
  GeoRegionsResponse,
  WiredState,
  WiredEnableRequest,
  WiredJoinRequest,
  WiredRelayRequest,
  WiredRelayResponse,
  ModelErrorShown,
  ServerInfoResponse,
  HealthResponse,
  SetupProvider,
  SetupLocalServer,
  SetupInfoResponse,
  SetupCodeRequest,
  SetupKeyRequest,
  SetupRequest,
  SetupResponse,
  RecoveryKitRequest,
  RecoveryKitResponse,
  BackupRemoteTarget,
  BackupState,
  SetBackupRemoteRequest,
  BackupNowResponse,
};
