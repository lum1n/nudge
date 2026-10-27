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
    /// Where someone from another assistant lives, such as `vegard@nudge.example.com/robin`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
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
    /// The model gets the images people attach here as they are (ADR 24); off when absent.
    #[serde(
        rename = "imagesToModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub images_to_model: Option<bool>,
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
    /// What it was sent with; left out for those a private message isn't for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}

/// A file sent with a message (ADR 24).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    /// `a1`, `a2`, … within its room.
    pub id: String,
    pub name: String,
    /// Its media type, such as `image/jpeg`.
    pub mime: String,
    /// In bytes.
    pub size: u64,
    pub kind: AttachmentKind,
}

/// `image` for PNG, JPEG, GIF and WebP, which can reach the model; `file` for the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    File,
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

/// What an answer answers, when it isn't a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptedBy {
    /// A scheduled nudge that fired.
    Nudge,
    /// Something new a watch found.
    Watch,
    #[serde(other)]
    Unknown,
}

/// One answer: every model response and tool round between two messages.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnswerItem {
    pub id: String,
    pub status: AnswerStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub parts: Vec<Part>,
    /// When its first model response started, in ms since the epoch.
    #[serde(default, rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    #[serde(
        default,
        rename = "promptedBy",
        skip_serializing_if = "Option::is_none"
    )]
    pub prompted_by: Option<PromptedBy>,
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
    /// What it was sent with, as on a user item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
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
    /// Only an admin may decide it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_only: Option<bool>,
    /// What approving it takes, besides a yes; see `ApprovalInput`. One this client can't read
    /// is left out.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "lenient_inputs"
    )]
    pub inputs: Vec<ApprovalInput>,
    /// What the app does before it approves; see `ClientAction`. `None` for one this client
    /// doesn't know, so it can still deny.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_action"
    )]
    pub client_action: Option<ClientAction>,
}

/// Something approving an approval takes, such as a password; the value is sent with the yes and
/// never stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApprovalInput {
    /// What the handler gets it as: letters, digits and `_`.
    pub name: String,
    pub label: String,
    /// A password field: the value isn't shown while typed.
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// It may be left empty; required otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
}

/// Something the app does on the device before it approves, with what only the device has, such
/// as its exe.dev token (ADR 11); then it approves with the inputs the action names.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientAction {
    /// Adds `ssh_key` (when given) to the person's exe.dev account, makes the VM, and approves
    /// with `vm` and `sshHost`.
    #[serde(rename = "exe.new", rename_all = "camelCase")]
    ExeNew {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ssh_key: Option<String>,
    },
    /// Removes the VM, and approves with nothing.
    #[serde(rename = "exe.rm")]
    ExeRm { name: String },
}

fn lenient_inputs<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<ApprovalInput>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect(),
        _ => Vec::new(),
    })
}

fn lenient_action<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ClientAction>, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(deserializer)?).ok())
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
    /// The members whose location the model may know here: a personal room's owner once their
    /// device shared one, and in a shared room those who chose to share it there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing_location: Option<Vec<Player>>,
}

// The room list: the player's rooms and nudges.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomListEntry {
    pub room: Room,
    pub running: bool,
    pub pending_approvals: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_item_at: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomListNudge {
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
pub struct RoomListView {
    pub player: Player,
    pub rooms: Vec<RoomListEntry>,
    /// Soonest first.
    pub nudges: Vec<RoomListNudge>,
    /// The assistant's robot; the app icon's when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
}

/// How the assistant's robot looks in the apps. Colours are `#rrggbb`. `eye_shape` and
/// `accessory` are strings so that ones a newer server knows still read: apps draw the app icon's
/// for those they don't.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    /// The ribbon's two ends.
    pub body: [String; 2],
    pub eyes: String,
    pub sparks: String,
    /// `pill`, `round`, `square` or `wide`.
    pub eye_shape: String,
    /// `none`, `antenna`, `headphones`, `sprout` or `crown`.
    pub accessory: String,
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

/// What a subscription follows: `"rooms"` or `"room:<id>"` on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Target {
    RoomList,
    Room(String),
}

impl Target {
    /// The target `text` names, or `None` when it names none.
    pub fn parse(text: &str) -> Option<Target> {
        match text {
            "rooms" => Some(Target::RoomList),
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
            Target::RoomList => f.write_str("rooms"),
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
    /// `RoomListView`, after the target; it stays JSON so that patches can apply to it.
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

/// What an error is, where a client acts on it rather than only showing `error`.
pub mod error_code {
    /// A 429 for asking too often: try again after `Retry-After` seconds, when given.
    pub const RATE_LIMITED: &str = "rate_limited";
    /// A 429 for a message once the caller's or the assistant's monthly budget is spent.
    pub const BUDGET_SPENT: &str = "budget_spent";
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
    /// One of `error_code`, or one a later server adds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantInfo {
    pub name: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
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

/// The room keeps its id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenameRoomRequest {
    pub name: String,
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
    /// Ids of attachments the sender uploaded to the room and hasn't sent yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
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
    /// The approval's inputs by name, when approving; ignored when denying. Never stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<std::collections::HashMap<String, String>>,
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
    /// Why it failed to start; it is off, in every room, until it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

/// One of the assistant's extensions as an admin sets it up, or one found beside the config that
/// nobody added yet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSetup {
    /// As the config writes it; sent back to say which one.
    pub from: String,
    /// Absent when the module could not be loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// In the config; false for one found in `extensions/` that nobody added yet.
    pub configured: bool,
    /// Installed: configured and not turned off.
    pub enabled: bool,
    /// The kinds of room it is on in by default; absent for every kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rooms: Option<Vec<RoomKind>>,
    pub settings: serde_json::Map<String, Value>,
    /// Its settings as JSON Schema; absent when it takes none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    /// `${NAME}` references in its settings that the server's environment doesn't set.
    pub missing_env: Vec<String>,
    /// Why the module could not be loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Why its setup threw when the assistant opened; it is left out until it starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExtensionSetupsResponse {
    pub extensions: Vec<ExtensionSetup>,
}

/// One extension of a `SaveExtensionSetupsRequest`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedExtensionSetup {
    pub from: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rooms: Option<Vec<RoomKind>>,
}

/// The assistant's extensions, in the order they are installed; ones left out are removed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SaveExtensionSetupsRequest {
    pub extensions: Vec<SavedExtensionSetup>,
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
    /// When it last signed in a request or socket, to the minute; absent until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<f64>,
    /// When it stops working; absent for one that works until revoked, as apps' do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokensResponse {
    pub tokens: Vec<TokenInfo>,
}

/// Every room of the assistant, for admins.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomsResponse {
    pub rooms: Vec<Room>,
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

/// A phone or a Mac that takes native pushes: from the server itself, or through a push relay.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DeviceRequest {
    Native(NativeDevice),
    Relay(RelayDevice),
}

/// An APNs device token (hex) or an FCM registration token, for a server that sends to the app
/// with its own credentials.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NativeDevice {
    pub platform: DevicePlatform,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<PushEnvironment>,
    /// The app's name for this sign-in, given back in every push.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// Always `relay`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelayPlatform {
    Relay,
}

/// A push relay's handle for the device, and the device's X25519 key (32 bytes, base64url) that
/// the server seals its pushes for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDevice {
    pub platform: RelayPlatform,
    pub relay: String,
    pub handle: String,
    pub device_key: String,
    /// The app's name for this sign-in, given back in every push.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// Which native pushes the server can send, and the push relays it sends through.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DevicesResponse {
    pub apns: bool,
    pub fcm: bool,
    #[serde(default)]
    pub relays: Vec<String>,
}

/// A circle a phone watches for the places extension (ADR 18), entering and leaving.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArrivalRegion {
    /// `p:<name>` for a saved place, `k:<id>` for a place of a kind.
    pub id: String,
    pub latitude: f64,
    pub longitude: f64,
    /// Metres.
    pub radius: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RefreshCircle {
    pub latitude: f64,
    pub longitude: f64,
    pub radius: f64,
}

/// What the phone watches. Leaving `refresh` means asking again from where it is then.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArrivalRegionsResponse {
    pub version: f64,
    pub regions: Vec<ArrivalRegion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<RefreshCircle>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionEvent {
    Enter,
    Exit,
}

/// The phone got to or left a region.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionEventRequest {
    pub region_id: String,
    pub event: RegionEvent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegionEventResponse {
    pub fired: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedPlace {
    pub name: String,
    pub placeholder: String,
    pub address: String,
    pub radius: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArrivalOn {
    Arrive,
    Leave,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArrivalRepeat {
    Once,
    Always,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrivalReminder {
    pub id: String,
    pub room_id: String,
    pub on: ArrivalOn,
    pub repeat: ArrivalRepeat,
    /// A saved place's name; absent for any place of a kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    /// Such as "grocery store".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub message: String,
}

/// The caller's saved places and arrival reminders, values readable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlacesResponse {
    pub places: Vec<SavedPlace>,
    pub reminders: Vec<ArrivalReminder>,
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

/// Which pushes a player gets; each kind is on unless `false`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NotificationPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals: Option<bool>,
}

/// What a player says about themselves. Their home keeps it; other assistants are sent it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub display_name: String,
    /// A `data:image/…;base64,` URL of at most 64 KiB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// IANA, such as `Europe/Oslo`; the assistant's when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    /// BCP 47, such as `nb`: the assistant answers the player in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationPrefs>,
    /// Each extension's preferences for the player, by extension name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<std::collections::BTreeMap<String, serde_json::Map<String, Value>>>,
}

/// The fields to change: `None` leaves one as it is, `Some(None)` clears it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub avatar: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub time_zone: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub language: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub notifications: Option<Option<NotificationPrefs>>,
    /// By extension name: each one named is replaced, `None` clears it; `Some(None)` clears all.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub extensions: Option<Option<ExtensionSettingsUpdate>>,
}

/// A player's personal details, as they see them. Each value is theirs alone: the model and
/// everyone else only ever see its placeholder. Kept by the assistant they were given to.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<KnownLocation>,
    /// The shared rooms where they let the model know where they are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_rooms: Option<Vec<String>>,
}

/// Whether the model may know where the caller is in a shared room, for anyone there.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShareLocationRequest {
    pub shared: bool,
}

/// Where a player's device last said they were (`place (lat, lon)`), and when.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KnownLocation {
    pub text: String,
    /// In ms since the epoch.
    pub at: f64,
}

/// Where a device is, and the place it named, such as a street address.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LocationRequest {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
}

/// The details to change: `None` leaves one as it is, `Some(None)` (or an empty string) clears it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePersonalRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub full_name: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub email: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub phone: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub address: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub location: Option<Option<LocationRequest>>,
}

/// Each extension's new preferences for the player by name; `None` clears an extension's.
pub type ExtensionSettingsUpdate =
    std::collections::BTreeMap<String, Option<serde_json::Map<String, Value>>>;

/// A field that may be left out (`None`), sent as `null` (`Some(None)`) or set.
mod nullable {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

/// An installed extension that takes settings from each player, for a profile's settings form.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerSettingsSchema {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Schema of what the player may choose, with the defaults of what they leave out.
    pub schema: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerSettingsResponse {
    pub extensions: Vec<PlayerSettingsSchema>,
}

/// An assistant by its server and its name there, such as one to join.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PlaceRequest {
    pub server: String,
    pub assistant: String,
}

/// An assistant the caller joined from here, their home; `carry_memory` once they allowed it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub server: String,
    pub assistant: String,
    pub since: f64,
    pub carry_memory: bool,
}

/// `address` is the caller's, such as `vegard@nudge.example.com/robin`, for admins elsewhere.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MembershipsResponse {
    pub address: String,
    pub memberships: Vec<Membership>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CarryMemoryRequest {
    pub server: String,
    pub assistant: String,
    pub carry: bool,
}

/// Signed by one assistant and encrypted for another; clients only pass it on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sealed {
    /// Always 1.
    pub v: u8,
    pub epk: String,
    pub iv: String,
    pub data: String,
    pub tag: String,
}

/// A server, by its address: one the caller owns, or one to vouch for them to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerRequest {
    pub server: String,
}

/// A server the caller owns, kept at their home so all their devices see it (ADR 11).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OwnedServer {
    pub server: String,
    pub since: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OwnedServersResponse {
    pub servers: Vec<OwnedServer>,
}

/// The caller's home vouching for them, for the assistant they asked about only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssertResponse {
    pub assertion: Sealed,
}

/// Answered with a `PairResponse`: a token for the player there, `address` the caller's home.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JoinRequest {
    pub assertion: Sealed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteRequest {
    pub address: String,
}

/// Someone an admin asked to join, by their address; good for a week.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub address: String,
    /// The admin's player id.
    pub by: String,
    pub created_at: f64,
    pub expires_at: f64,
}

/// `link` is `nudge://join?server=…&assistant=…`, for the invited person's app.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteResponse {
    pub invite: Invite,
    pub link: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InvitesResponse {
    pub invites: Vec<Invite>,
}

/// A player as an admin sees them: whether they may use the admin routes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminPlayer {
    pub id: String,
    pub display_name: String,
    pub admin: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetAdminRequest {
    pub admin: bool,
}

/// `None` goes back to the app icon's robot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetAppearanceRequest {
    pub appearance: Option<Appearance>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AppearanceResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
}

// The server's own API, under `/v1/server` (ADR 11): for its owners, not an assistant's admins.

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub provider: String,
    pub model_id: String,
}

/// Monthly limits on model spend, in US dollars.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantBudget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_player_usd: Option<f64>,
    /// The share of a limit at which people hear about it, between 0 and 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warn_at: Option<f64>,
    /// Without `monthly_usd`, the spend at which admins hear there is no limit; default 25.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warn_usd: Option<f64>,
}

/// How much an assistant says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantStyle {
    Concise,
    Balanced,
    Detailed,
}

/// How much an assistant decides itself before asking; approvals apply at every level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantAutonomy {
    Cautious,
    Balanced,
    Independent,
}

/// One of the server's assistants, with its settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAssistant {
    /// In its URLs and its people's addresses; it never changes.
    pub name: String,
    pub display_name: String,
    pub model: ModelChoice,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<AssistantStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomy: Option<AssistantAutonomy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<AssistantBudget>,
    /// False when it is in the config but failed to open.
    pub running: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerAssistantsResponse {
    pub assistants: Vec<ServerAssistant>,
}

/// The person an assistant is made for, when it is to be their home.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstPlayer {
    pub display_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssistantRequest {
    /// Lower-case letters, digits and dashes.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<AssistantStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomy: Option<AssistantAutonomy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<AssistantBudget>,
    /// Someone whose home it is to be: its first player, so its admin, with a pairing code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_player: Option<FirstPlayer>,
    /// An address to invite, such as the owner's own: their app joins it from home.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite: Option<String>,
}

/// The pairing code of an assistant's first player.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstPlayerPairing {
    pub code: String,
    /// `nudge://pair?server=…&assistant=…&code=…`, for a link or a QR code.
    pub link: String,
    pub expires_at: f64,
    pub player_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssistantResponse {
    pub assistant: ServerAssistant,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing: Option<FirstPlayerPairing>,
    /// For `invite`: `nudge://join?server=…&assistant=…`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_link: Option<String>,
}

/// Someone to invite to an assistant by their address, as an owner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteToAssistantRequest {
    pub address: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteToAssistantResponse {
    /// `nudge://join?server=…&assistant=…`, which their app joins with from home.
    pub join_link: String,
}

/// Each field: `None` leaves it, `Some(None)` goes back to the default, `Some(Some(_))` sets it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssistantRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub display_name: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub model: Option<Option<ModelChoice>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub time_zone: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub instructions: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub style: Option<Option<AssistantStyle>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub autonomy: Option<Option<AssistantAutonomy>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub budget: Option<Option<AssistantBudget>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeleteAssistantResponse {
    /// The backup made before it went, kept a while in the server's `server/deleted`.
    pub backup: String,
}

/// Where an assistant's key for a model provider comes from; the key itself is never shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    /// The server's environment, which wins.
    Env,
    Server,
    Assistant,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderKey {
    pub provider: String,
    pub source: KeySource,
    /// For `Env`: which variables.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variables: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderKeysResponse {
    pub keys: Vec<ProviderKey>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetProviderKeyRequest {
    pub key: String,
    /// For one assistant only; default every assistant on the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
    /// Send one tiny request with it first, and refuse it if that fails; default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOwner {
    pub id: String,
    /// For someone who lives on one of the server's assistants: it, and their id there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
    /// For someone whose home is elsewhere, which vouches for them: their address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub added_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerOwnersResponse {
    pub owners: Vec<ServerOwner>,
}

/// A player of one of the server's assistants (`assistant` and `player_id`), or an `address`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddOwnerRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
    /// Makes the player an admin of `assistant` too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

/// Sent with the player's token of `assistant`, or with `assertion` alone: their home vouching
/// for them to this server, from the home's `POST /ext/federation/owner-assertion`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerSessionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
    pub client: ClientInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assertion: Option<Sealed>,
}

/// The server's own keys, as homes seal owner assertions to it (ADR 11).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerKeyResponse {
    pub signing_key: String,
    pub encryption_key: String,
}

/// `token` is shown only here; keep it like a password.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSessionResponse {
    pub token: String,
    pub client_id: String,
    pub owner: ServerOwner,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// The version running.
    pub current: String,
    /// Whether the server installs new releases itself.
    pub automatic: bool,
    /// A newer release the project signed, not installed yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<f64>,
    /// Why the last check failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetUpdatesRequest {
    pub automatic: bool,
}

/// How far the server's map is (ADR 18).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GeoState {
    Off,
    Working,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GeoRegionState {
    Waiting,
    Downloading,
    Importing,
    Ready,
    Failed,
}

/// Picked by an owner, or fetched because someone was there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GeoRegionBy {
    Owner,
    Follow,
}

/// One region of the server's map.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoRegionStatus {
    /// Geofabrik's id, such as `norway` or `us/california`.
    pub id: String,
    pub name: String,
    pub by: GeoRegionBy,
    pub state: GeoRegionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// Of the current download, from 0 to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The server's own map: addresses, places and routes from OpenStreetMap, for regions anywhere in
/// the world.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoStatus {
    pub state: GeoState,
    /// Whether it fetches the region someone's phone says they are in.
    pub follow: bool,
    pub limit_gb: f64,
    pub used_bytes: f64,
    pub regions: Vec<GeoRegionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What changes: the regions owners want (the whole list), following people, the disk limit.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGeoRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_gb: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GeoRegion {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// Every region the map can hold.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GeoRegionsResponse {
    pub regions: Vec<GeoRegion>,
}

/// How far the server's Wired is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WiredStatus {
    Off,
    /// This release has no Wired.
    Unavailable,
    Starting,
    /// This server holds the network.
    Root,
    /// It joined one.
    Member,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WiredMember {
    pub name: String,
    pub anchor: bool,
}

/// The server's Wired: an encrypted network between Nudge servers that needs no open port at
/// home. Other servers reach this one's API at `http://nudge.<name>.wired`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WiredState {
    pub state: WiredStatus,
    /// Its name in the network. While off, the name it takes when turned on or joining, unless
    /// the owner picks another.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<WiredMember>>,
    /// The network's relays: public addresses every server reaches the others through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relays: Option<Vec<String>>,
    /// The relay this server serves, at its public address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Makes the server the root of its own network, as `name` (such as `box`) when given; else its
/// public address's first label, or the host's name.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WiredEnableRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A relay a new server will serve, such as `https://robin.exe.xyz`, added before it joins.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WiredRelayRequest {
    pub url: String,
}

/// Joins the network `invite` is for, as `name` when given. The server serves a relay at its public HTTPS address, or
/// `relay_url`, which the root must have listed first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WiredJoinRequest {
    pub invite: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    /// Its name in the network, such as `box`; see `WiredEnableRequest`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// The invite the new server joins with, in `NUDGE_WIRED_INVITE`. It is a credential.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WiredRelayResponse {
    pub invite: String,
}

/// A model request that failed, as owners see it: the provider's answer with placeholders where
/// personal values were, scrubbed of keys and cut short.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelErrorShown {
    /// When, in ms since the epoch.
    pub at: f64,
    /// The assistant's URL name, when the request was one of theirs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
    pub provider: String,
    pub model: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerInfoResponse {
    pub version: String,
    /// The owner whose token asked.
    pub owner: ServerOwner,
    pub assistants: Vec<ServerAssistant>,
    /// Absent for a server that can't update itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdateState>,
    /// The last model requests that failed, newest first; absent where the server keeps none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<ModelErrorShown>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecoveryKitRequest {
    pub passphrase: String,
}

/// The backup key sealed with the passphrase, as a file to keep away from the server.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecoveryKitResponse {
    pub kit: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Target {
    /// Such as `https://s3.eu-north-1.amazonaws.com` or `https://<account>.r2.cloudflarestorage.com`.
    pub endpoint: String,
    pub bucket: String,
    /// Default the one in an AWS endpoint, else `us-east-1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// A folder in the bucket, such as `nudge/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// Bucket in the path rather than the host name; default on, except for AWS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_style: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WebDavTarget {
    /// The folder, such as `https://cloud.example/remote.php/dav/files/me/nudge/`.
    pub url: String,
}

/// Where backups are copied off the server (ADR 8): an S3-compatible bucket or a WebDAV folder.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BackupRemoteTarget {
    S3(S3Target),
    Webdav(WebDavTarget),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialsFrom {
    Env,
    Server,
}

/// The access key id or user name the remote is reached with, and where it is set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BackupCredentials {
    pub user: String,
    pub from: CredentialsFrom,
}

/// The server's backups: where, how often, how many, and how the last upload went.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupState {
    /// Whether the server makes backups on its own; the rest is its defaults when it doesn't.
    pub on: bool,
    /// The folder on the server they go to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    pub every_hours: f64,
    /// Backups kept, in the folder and on the remote alike.
    pub keep: f64,
    /// When the newest in the folder was made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_backup_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<BackupRemoteTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<BackupCredentials>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_upload_at: Option<f64>,
    /// Why the last upload failed, when it did, and when.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<f64>,
}

/// A remote target for backups, with what to sign in with: an access key id and secret for S3, a
/// user name and password for WebDAV. Without them the kept ones stay. The server first writes,
/// lists and deletes a small file there, unless `test` is false.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetBackupRemoteRequest {
    #[serde(flatten)]
    pub target: BackupRemoteTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<bool>,
}

/// A backup made now: its file name, and why the upload failed if it did.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupNowResponse {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload_error: Option<String>,
}

// Setting a server up, under `/v1/setup` (ADR 11): open only while it has no config.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetupModel {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetupProvider {
    pub id: String,
    pub name: String,
    /// Best first.
    pub models: Vec<SetupModel>,
    /// The one to preselect.
    pub recommended: String,
}

/// A model server found on the machine, such as Ollama, that needs no key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupLocalServer {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetupInfoResponse {
    /// False once the server is set up, or after too many wrong codes until it restarts.
    pub open: bool,
    pub providers: Vec<SetupProvider>,
    pub local: Vec<SetupLocalServer>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetupCodeRequest {
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetupKeyRequest {
    pub code: String,
    pub provider: String,
    pub key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAssistant {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPerson {
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    pub code: String,
    pub client: ClientInfo,
    pub assistant: SetupAssistant,
    pub model: ModelChoice,
    /// The provider's key, tried again before it is kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The id of a found local server `model` is on, instead of a key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<String>,
    pub you: SetupPerson,
    /// The address the client reached the server at, kept for links and other assistants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    /// Nightly backups beside the config; default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backups: Option<bool>,
    /// Whether its assistant has federation, to be part of a cluster; default true. False sets
    /// it up standalone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub federation: Option<bool>,
    /// An owner assertion from the person's home, when they set it up signed in there: the server
    /// is started from that home, so its first player is them and its owner their address, and it
    /// can join their cluster later. Without one, the first player lives there, a new home.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<Sealed>,
}

/// The tokens are shown only here: the player's for the assistant, the owner's for the server.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResponse {
    pub assistant: String,
    pub player: Player,
    pub token: String,
    pub client_id: String,
    pub server_token: String,
    pub owner: ServerOwner,
}
