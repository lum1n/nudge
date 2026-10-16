//! The shapes of protocol v1, written by hand after the TypeBox schemas in `@nudge/protocol`
//! (`packages/protocol/src/schema.ts`). `docs/protocol/v1.md` explains them, and the tests check
//! these types against `packages/protocol/schema/v1.json` and the recorded fixtures.
//!
//! Unknown object keys are ignored, so a field added within v1 doesn't break this client. A part,
//! timeline item, status or server frame of a type this client doesn't know reads as `Unknown`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomKind {
    Lobby,
    Personal,
    Shared,
}

/// The lobby lists no members: everyone may use it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Room {
    pub id: String,
    pub kind: RoomKind,
    pub name: String,
    pub members: Vec<Player>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Done,
    Failed,
}

// The timeline: what a chat shows, oldest first.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Pending,
    Running,
    Done,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPart {
    pub call_id: String,
    pub name: String,
    pub args: serde_json::Map<String, Value>,
    pub status: ToolStatus,
    /// The result's text, once there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// What the tool returned for UIs, such as the browser's login button.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    /// What the tool printed so far, while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// `result` was cut, or `details` left out, for being too long.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Part {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Tool(ToolPart),
    #[serde(other)]
    Unknown,
}

/// A message. `author` is absent for input without a player, such as the in-process CLI's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserItem {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Player>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// The id its sender chose, so that sender can swap its optimistic copy for this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

/// A scheduled nudge that fired; the assistant answers it like a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NudgeItem {
    pub id: String,
    pub text: String,
    pub fired_at: f64,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

/// How an action people were asked to approve ended; the assistant answers it like a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalItem {
    pub id: String,
    pub approval_id: String,
    pub summary: String,
    pub status: ApprovalStatus,
    /// The display name of who decided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnswerStatus {
    Running,
    Done,
    Stopped,
    Failed,
}

/// One answer: every model response and tool round between two messages.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnswerItem {
    pub id: String,
    pub status: AnswerStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub parts: Vec<Part>,
    /// It answers something private: only this player sees its parts; everyone else gets none.
    #[serde(default, rename = "privateTo", skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkerKind {
    Compacted,
    Reset,
}

/// Where the transcript starts over: earlier messages were summarized, or cleared.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MarkerItem {
    pub id: String,
    pub kind: MarkerKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TimelineItem {
    User(UserItem),
    Nudge(NudgeItem),
    Approval(ApprovalItem),
    Answer(AnswerItem),
    Marker(MarkerItem),
    #[serde(other)]
    Unknown,
}

impl TimelineItem {
    /// The item's id; `None` for an item of a type this client doesn't know.
    pub fn id(&self) -> Option<&str> {
        match self {
            TimelineItem::User(item) => Some(&item.id),
            TimelineItem::Nudge(item) => Some(&item.id),
            TimelineItem::Approval(item) => Some(&item.id),
            TimelineItem::Answer(item) => Some(&item.id),
            TimelineItem::Marker(item) => Some(&item.id),
            TimelineItem::Unknown => None,
        }
    }
}

// The room view.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Status {
    Retrying {
        attempt: i64,
        at: f64,
        error: String,
    },
    Compacting,
    CompactionFailed {
        error: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueueMode {
    Steer,
    FollowUp,
}

/// A message waiting for the assistant to get to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: i64,
    pub mode: QueueMode,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Player>,
    /// As on a user item: its sender can tell its own message from the queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// A fired nudge or an ended approval rather than someone's message.
    pub nudge: bool,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    /// `a1`, `a2`, … within its room.
    pub id: String,
    pub summary: String,
    pub status: ApprovalStatus,
    pub requested_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<Player>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<f64>,
    /// What the action reported, once it ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub text: String,
    pub created_at: f64,
    /// Who remembered it; `None` when the assistant did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<Player>,
    /// Set on a member's own fact that the room shows because they share their memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Player>,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomNudge {
    pub id: String,
    pub message: String,
    pub fire_at: f64,
    /// Repeat interval in ms; absent for a one-off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<f64>,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Live {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomView {
    pub room: Room,
    /// The most recent items, oldest first.
    pub timeline: Vec<TimelineItem>,
    /// More items come from `GET /rooms/<id>/timeline`.
    pub has_earlier: bool,
    pub live: Live,
    pub queue: Vec<QueuedMessage>,
    /// Pending ones and the most recently decided, newest first.
    pub approvals: Vec<Approval>,
    /// Oldest first.
    pub memory: Vec<Fact>,
    /// Soonest first.
    pub nudges: Vec<RoomNudge>,
}

// The home view: the player's rooms and nudges.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeRoom {
    pub room: Room,
    pub running: bool,
    pub pending_approvals: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_item_at: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeNudge {
    pub id: String,
    pub room_id: String,
    pub message: String,
    pub fire_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<f64>,
    /// Only this player sees it; everyone else gets it emptied, so they know there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HomeView {
    pub player: Player,
    pub rooms: Vec<HomeRoom>,
    /// Soonest first.
    pub nudges: Vec<HomeNudge>,
}

// Patches.

/// An object key or an array index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathKey {
    Index(usize),
    Key(String),
}

/// Object keys and array indexes into a view.
pub type Path = Vec<PathKey>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    /// Set the value at `path`, adding the key if it's new. An empty path replaces the view.
    Set { path: Path, value: Value },
    /// Remove an object key.
    Del { path: Path },
    /// Append to the string at `path`.
    Append { path: Path, text: String },
    /// Change the array at `path` like `Array.prototype.splice`.
    Splice {
        path: Path,
        index: usize,
        remove: usize,
        insert: Vec<Value>,
    },
}

// The socket.

/// What a subscription follows: `"home"` or `"room:<id>"` on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Target {
    Home,
    Room(String),
}

impl Target {
    /// The target `text` names, or `None` when it names none.
    pub fn parse(text: &str) -> Option<Target> {
        match text {
            "home" => Some(Target::Home),
            _ => match text.strip_prefix("room:") {
                Some(id) if !id.is_empty() => Some(Target::Room(id.to_owned())),
                _ => None,
            },
        }
    }
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Target::Home => f.write_str("home"),
            Target::Room(id) => write!(f, "room:{id}"),
        }
    }
}

impl Serialize for Target {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Target {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Target::parse(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("not a target: {text:?}")))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientDescription {
    pub name: String,
    pub version: String,
    pub platform: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientFrame {
    /// Must be first.
    Hello {
        protocol: u32,
        token: String,
        client: ClientDescription,
    },
    Subscribe {
        target: Target,
    },
    Unsubscribe {
        target: Target,
    },
    Ping,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub version: String,
}

/// The reply to a good `hello`. A new `epoch` after reconnecting means subscribe again.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub protocol: u32,
    pub server: ServerInfo,
    pub epoch: String,
    pub player: Player,
    pub client_id: String,
    pub heartbeat_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnsubscribedReason {
    /// Not a room of this player, or no such room.
    NotFound,
    /// No longer a member.
    Removed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerFrame {
    Welcome(Welcome),
    /// The whole view, first after `subscribe`, with `seq` 0. `view` is a `RoomView` or a
    /// `HomeView`, after the target; it stays JSON so that patches can apply to it.
    Snapshot {
        target: Target,
        seq: u64,
        view: Value,
    },
    /// Changes since the previous frame for `target`; `seq` goes up by one.
    Patch {
        target: Target,
        seq: u64,
        ops: Vec<Op>,
    },
    Unsubscribed {
        target: Target,
        reason: UnsubscribedReason,
    },
    Pong,
    /// A frame the server couldn't use; the socket stays open.
    Error {
        message: String,
    },
    #[serde(other)]
    Unknown,
}

/// Socket close codes, after HTTP status codes.
pub mod close {
    pub const BAD_REQUEST: u16 = 4400;
    pub const UNAUTHORIZED: u16 = 4401;
    pub const NOT_FOUND: u16 = 4404;
    /// The host is shutting down.
    pub const GOING_AWAY: u16 = 1001;
}

// HTTP: request and response bodies under `/v1/a/<assistant>`.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantInfo {
    pub name: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssistantsResponse {
    pub assistants: Vec<AssistantInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub platform: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairRequest {
    pub code: String,
    pub client: ClientInfo,
}

/// `token` is shown only here; keep it like a password.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub token: String,
    pub client_id: String,
    pub player: Player,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub player: Player,
    pub client_id: String,
    /// May use the `/admin` routes.
    pub admin: bool,
}

/// The caller is always a member; `members` are other player ids.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreateRoomRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhenBusy {
    FollowUp,
    Steer,
    Reject,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRequest {
    pub text: String,
    /// Chosen by the client; sending the same one again is answered with the same submission.
    pub request_id: String,
    /// What to do while the assistant is answering. Default `followUp`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_busy: Option<WhenBusy>,
    /// Only the sender sees the message and the answer to it; the room sees that there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    pub submission_id: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimelineResponse {
    /// Oldest first.
    pub items: Vec<TimelineItem>,
    /// Pass as `before` for the page before this one; absent at the start of the room.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RememberRequest {
    pub text: String,
}

/// The caller's own memory: shown in their personal room, and in all their rooms when `shared`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerMemoryResponse {
    pub facts: Vec<Fact>,
    pub shared: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShareMemoryRequest {
    pub shared: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecideRequest {
    pub approve: bool,
}

/// An installed extension as one room has it. The built-in one is always on and not listed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomExtension {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the room's conversation uses it.
    pub enabled: bool,
    /// Whether it is on in rooms of this kind by default; `enabled` differs when the room chose.
    pub by_default: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomExtensionsResponse {
    pub extensions: Vec<RoomExtension>,
}

/// `None` goes back to the default for the room's kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetRoomExtensionRequest {
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProtectRequest {
    pub value: String,
    /// Upper-case letters, such as `NAME`; default `PRIVATE`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Also hide the value from everyone but the caller, wherever it shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProtectResponse {
    pub placeholder: String,
}

/// A value only its owner sees; others see `placeholder`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PrivateValue {
    pub placeholder: String,
    pub kind: String,
    pub value: String,
}

/// The caller's private values, in the order they were made private.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PrivateValuesResponse {
    pub values: Vec<PrivateValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlayerRequest {
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerResponse {
    pub player: Player,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeRequest {
    pub player_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeResponse {
    pub code: String,
    /// `nudge://pair?server=…&assistant=…&code=…`, for a link or a QR code.
    pub link: String,
    pub expires_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub client_id: String,
    pub player_id: String,
    pub created_at: f64,
    /// What the client said it is when it paired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokensResponse {
    pub tokens: Vec<TokenInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DevicePlatform {
    Apns,
    Fcm,
}

/// Apps built for development take APNs pushes through Apple's sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushEnvironment {
    Production,
    Sandbox,
}

/// A phone or a Mac that takes native pushes: an APNs device token (hex) or an FCM registration
/// token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceRequest {
    pub platform: DevicePlatform,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<PushEnvironment>,
}

/// Which native pushes the server can send.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DevicesResponse {
    pub apns: bool,
    pub fcm: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelRole {
    System,
    User,
    Assistant,
    ToolResult,
}

/// One message of the conversation as the model gets it, placeholders and all.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelMessage {
    pub role: ModelRole,
    pub text: String,
}

/// What the model saw in a room: its context, redacted as sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelViewResponse {
    pub messages: Vec<ModelMessage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBudget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_player_usd: Option<f64>,
}

/// One month's model spend, in US dollars.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MonthUsage {
    /// `YYYY-MM` in the assistant's time zone.
    pub month: String,
    pub total: f64,
    /// By player id.
    pub players: std::collections::BTreeMap<String, f64>,
    /// By room id.
    pub rooms: std::collections::BTreeMap<String, f64>,
}

/// The month's spend and limits; `months` for admins only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageResponse {
    pub month: String,
    pub total: f64,
    /// What answering the caller's messages cost this month.
    pub mine: f64,
    pub budget: UsageBudget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub months: Option<Vec<MonthUsage>>,
}
