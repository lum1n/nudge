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

export const RoomListView = Type.Object({
  player: Player,
  rooms: Type.Array(RoomListEntry),
  /** Soonest first. */
  nudges: Type.Array(RoomListNudge),
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

export const ErrorResponse = Type.Object({ error: Type.String() });
export type ErrorResponse = Static<typeof ErrorResponse>;

export const AssistantsResponse = Type.Object({
  assistants: Type.Array(Type.Object({ name: Type.String(), displayName: Type.String() })),
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
  text: Type.String(),
  /** Chosen by the client; sending the same one again is answered with the same submission. */
  requestId: Type.String(),
  /** What to do while the assistant is answering. Default `followUp`. */
  whenBusy: Type.Optional(WhenBusy),
  /** Only the sender sees the message and the answer to it; the room sees that there was one. */
  private: Type.Optional(Type.Boolean()),
});
export type MessageRequest = Static<typeof MessageRequest>;

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
export type PlayersResponse = Static<typeof PlayersResponse>;

export const SetAdminRequest = Type.Object({ admin: Type.Boolean() });
export type SetAdminRequest = Static<typeof SetAdminRequest>;

/** A new token for an existing player; like `PairResponse`, the token is shown only here. */
export const IssueTokenRequest = Type.Object({ playerId: Type.String() });
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
  PlayerSettingsSchema,
  PlayerSettingsResponse,
  PushKeyResponse,
  PushSubscribeRequest,
  PushRenewRequest,
  DeviceRequest,
  DevicesResponse,
  PlaceRequest,
  Membership,
  MembershipsResponse,
  CarryMemoryRequest,
  Sealed,
  AssertResponse,
  JoinRequest,
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
  SetAdminRequest,
  IssueTokenRequest,
  RoomsResponse,
  AdminCreateRoomRequest,
  NudgesResponse,
};
