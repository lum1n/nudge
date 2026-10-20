//! The protocol's shapes as UniFFI records and enums. Free-form JSON (a tool's args and details)
//! crosses as a JSON string, and times as milliseconds since the epoch.

use std::collections::HashMap;

use nudge_client::protocol as p;

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Player {
    pub id: String,
    pub display_name: String,
    /// Where someone from another assistant lives, such as `vegard@nudge.example.com/robin`.
    pub address: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum RoomKind {
    Lobby,
    Personal,
    Shared,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Room {
    pub id: String,
    pub kind: RoomKind,
    pub name: String,
    pub members: Vec<Player>,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Done,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum ToolStatus {
    Pending,
    Running,
    Done,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ToolPart {
    pub call_id: String,
    pub name: String,
    /// The arguments as a JSON object.
    pub args_json: String,
    pub status: ToolStatus,
    pub result: Option<String>,
    pub is_error: Option<bool>,
    /// What the tool returned for UIs, as JSON.
    pub details_json: Option<String>,
    pub output: Option<String>,
    pub truncated: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum Part {
    Text { text: String },
    Reasoning { text: String },
    Tool { tool: ToolPart },
}

/// What an answer answers, when it isn't a message.
#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum PromptedBy {
    Nudge,
    Watch,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum AnswerStatus {
    Running,
    Done,
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum MarkerKind {
    Compacted,
    Reset,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum TimelineItem {
    User {
        id: String,
        text: String,
        author: Option<Player>,
        sent_at: Option<f64>,
        client_id: Option<String>,
        request_id: Option<String>,
        /// Only this player sees it; everyone else gets it emptied.
        private_to: Option<Player>,
    },
    Nudge {
        id: String,
        text: String,
        fired_at: f64,
        /// Only this player sees it; everyone else gets it emptied.
        private_to: Option<Player>,
    },
    Approval {
        id: String,
        approval_id: String,
        summary: String,
        status: ApprovalStatus,
        decided_by: Option<String>,
        /// Only this player sees it; everyone else gets it emptied.
        private_to: Option<Player>,
    },
    Answer {
        id: String,
        status: AnswerStatus,
        error: Option<String>,
        parts: Vec<Part>,
        /// When its first model response started, in ms since the epoch.
        started_at: Option<f64>,
        /// It answers a fired nudge or a watch, rather than a message.
        prompted_by: Option<PromptedBy>,
        /// Only this player sees it; everyone else gets it emptied.
        private_to: Option<Player>,
    },
    Marker {
        id: String,
        kind: MarkerKind,
    },
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
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
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Live {
    pub running: bool,
    pub status: Option<Status>,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum QueueMode {
    Steer,
    FollowUp,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct QueuedMessage {
    pub id: i64,
    pub mode: QueueMode,
    pub text: String,
    pub author: Option<Player>,
    pub client_id: Option<String>,
    pub request_id: Option<String>,
    pub nudge: bool,
    /// Only this player sees it; everyone else gets it with empty text.
    #[uniffi(default = None)]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Approval {
    pub id: String,
    pub summary: String,
    pub status: ApprovalStatus,
    pub requested_at: f64,
    pub decided_by: Option<Player>,
    pub decided_at: Option<f64>,
    pub result: Option<String>,
    /// Asked for in answer to something private: only this player sees and decides it.
    #[uniffi(default = None)]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Fact {
    pub id: String,
    pub text: String,
    pub created_at: f64,
    /// Who remembered it; `None` when the assistant did.
    pub by: Option<Player>,
    /// Set on a member's own fact that the room shows because they share their memory.
    pub owner: Option<Player>,
    /// Remembered in answer to something private: only this player sees it.
    #[uniffi(default = None)]
    pub private_to: Option<Player>,
}

/// The caller's own memory: shown in their personal room, and in all their rooms when `shared`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PlayerMemory {
    pub facts: Vec<Fact>,
    pub shared: bool,
}

/// An installed extension as one room has it. The built-in one is always on and not listed.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RoomExtension {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    /// Whether the room's conversation uses it.
    pub enabled: bool,
    /// Whether it is on in rooms of this kind by default; `enabled` differs when the room chose.
    pub by_default: bool,
}

/// One of the assistant's extensions as an admin sets it up, or one found beside the config that
/// nobody added yet. Its settings and their JSON Schema cross as JSON strings.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ExtensionSetup {
    /// As the config writes it; sent back to say which one.
    pub from: String,
    /// Absent when the module could not be loaded.
    pub name: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    /// In the config; false for one that nobody added yet.
    pub configured: bool,
    /// Installed: configured and not turned off.
    pub enabled: bool,
    /// The kinds of room it is on in by default; absent for every kind.
    pub rooms: Option<Vec<RoomKind>>,
    /// Its settings, a JSON object.
    pub settings_json: String,
    /// Its settings' JSON Schema; absent when it takes none.
    pub schema_json: Option<String>,
    /// `${NAME}` references in its settings that the server's environment doesn't set.
    pub missing_env: Vec<String>,
    /// Why the module could not be loaded.
    pub error: Option<String>,
}

/// An extension as `save_extension_setups` installs it.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SavedExtensionSetup {
    pub from: String,
    pub enabled: bool,
    /// A JSON object; absent for no settings.
    pub settings_json: Option<String>,
    /// Absent for every kind of room.
    pub rooms: Option<Vec<RoomKind>>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RoomNudge {
    pub id: String,
    pub message: String,
    pub fire_at: f64,
    pub every: Option<f64>,
    /// Scheduled in answer to something private: only this player sees it.
    #[uniffi(default = None)]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RoomListEntry {
    pub room: Room,
    pub running: bool,
    pub pending_approvals: u32,
    pub last_item_at: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RoomListNudge {
    pub id: String,
    pub room_id: String,
    pub message: String,
    pub fire_at: f64,
    pub every: Option<f64>,
    #[uniffi(default = None)]
    pub private_to: Option<Player>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RoomListView {
    pub player: Player,
    pub rooms: Vec<RoomListEntry>,
    pub nudges: Vec<RoomListNudge>,
    /// The assistant's robot; the app icon's when absent.
    pub appearance: Option<Appearance>,
}

/// How the assistant's robot looks: colours as `#rrggbb`, `body` the ribbon's two ends. Apps draw
/// the app icon's eyes or nothing worn for an `eye_shape` or `accessory` they don't know.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Appearance {
    pub body: Vec<String>,
    pub eyes: String,
    pub sparks: String,
    pub eye_shape: String,
    pub accessory: String,
}

impl From<p::Appearance> for Appearance {
    fn from(look: p::Appearance) -> Self {
        Appearance {
            body: look.body.to_vec(),
            eyes: look.eyes,
            sparks: look.sparks,
            eye_shape: look.eye_shape,
            accessory: look.accessory,
        }
    }
}

impl From<Appearance> for p::Appearance {
    fn from(look: Appearance) -> Self {
        let end = |i: usize| look.body.get(i).cloned().unwrap_or_default();
        p::Appearance {
            body: [end(0), end(1)],
            eyes: look.eyes,
            sparks: look.sparks,
            eye_shape: look.eye_shape,
            accessory: look.accessory,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum WhenBusy {
    FollowUp,
    Steer,
    Reject,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum SyncStatus {
    Syncing,
    Live,
    Gone,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum GoneReason {
    NotFound,
    Removed,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum PendingState {
    Sending,
    Waiting { error: String },
    Failed { error: String },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PendingMessage {
    pub request_id: String,
    pub text: String,
    pub when_busy: Option<WhenBusy>,
    pub state: PendingState,
    /// Only the sender sees it and the answer to it.
    #[uniffi(default = false)]
    pub private: bool,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct MeInfo {
    pub player: Player,
    pub client_id: String,
    pub admin: bool,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Paired {
    pub client_id: String,
    pub player: Player,
}

/// A value only its owner sees; others see `placeholder`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PrivateValue {
    pub placeholder: String,
    pub kind: String,
    pub value: String,
}

impl From<p::PrivateValue> for PrivateValue {
    fn from(value: p::PrivateValue) -> Self {
        PrivateValue {
            placeholder: value.placeholder,
            kind: value.kind,
            value: value.value,
        }
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PairingCode {
    pub code: String,
    pub link: String,
    pub expires_at: f64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Assistant {
    pub name: String,
    pub display_name: String,
    pub appearance: Option<Appearance>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum Sent {
    Delivered {
        submission_id: i64,
    },
    /// It waits in the outbox and is sent again once the socket is open.
    Queued,
}

impl From<p::Player> for Player {
    fn from(player: p::Player) -> Self {
        Player {
            id: player.id,
            display_name: player.display_name,
            address: player.address,
        }
    }
}

impl From<p::RoomKind> for RoomKind {
    fn from(kind: p::RoomKind) -> Self {
        match kind {
            p::RoomKind::Lobby => RoomKind::Lobby,
            p::RoomKind::Personal => RoomKind::Personal,
            p::RoomKind::Shared => RoomKind::Shared,
        }
    }
}

impl From<RoomKind> for p::RoomKind {
    fn from(kind: RoomKind) -> Self {
        match kind {
            RoomKind::Lobby => p::RoomKind::Lobby,
            RoomKind::Personal => p::RoomKind::Personal,
            RoomKind::Shared => p::RoomKind::Shared,
        }
    }
}

impl From<p::ExtensionSetup> for ExtensionSetup {
    fn from(setup: p::ExtensionSetup) -> Self {
        ExtensionSetup {
            from: setup.from,
            name: setup.name,
            version: setup.version,
            description: setup.description,
            configured: setup.configured,
            enabled: setup.enabled,
            rooms: setup
                .rooms
                .map(|rooms| rooms.into_iter().map(Into::into).collect()),
            settings_json: serde_json::Value::Object(setup.settings).to_string(),
            schema_json: setup.schema.as_ref().map(ToString::to_string),
            missing_env: setup.missing_env,
            error: setup.error,
        }
    }
}

impl From<p::Room> for Room {
    fn from(room: p::Room) -> Self {
        Room {
            id: room.id,
            kind: room.kind.into(),
            name: room.name,
            members: room.members.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<p::ApprovalStatus> for ApprovalStatus {
    fn from(status: p::ApprovalStatus) -> Self {
        match status {
            p::ApprovalStatus::Pending => ApprovalStatus::Pending,
            p::ApprovalStatus::Approved => ApprovalStatus::Approved,
            p::ApprovalStatus::Denied => ApprovalStatus::Denied,
            p::ApprovalStatus::Done => ApprovalStatus::Done,
            p::ApprovalStatus::Failed => ApprovalStatus::Failed,
        }
    }
}

fn part(part: &p::Part) -> Option<Part> {
    Some(match part {
        p::Part::Text { text } => Part::Text { text: text.clone() },
        p::Part::Reasoning { text } => Part::Reasoning { text: text.clone() },
        p::Part::Tool(tool) => Part::Tool {
            tool: ToolPart {
                call_id: tool.call_id.clone(),
                name: tool.name.clone(),
                args_json: serde_json::Value::Object(tool.args.clone()).to_string(),
                status: match tool.status {
                    p::ToolStatus::Pending => ToolStatus::Pending,
                    p::ToolStatus::Running => ToolStatus::Running,
                    p::ToolStatus::Done => ToolStatus::Done,
                },
                result: tool.result.clone(),
                is_error: tool.is_error,
                details_json: tool.details.as_ref().map(ToString::to_string),
                output: tool.output.clone(),
                truncated: tool.truncated,
            },
        },
        p::Part::Unknown => return None,
    })
}

/// The item for UIs; `None` for one of a type this client doesn't know.
pub fn timeline_item(item: &p::TimelineItem) -> Option<TimelineItem> {
    Some(match item {
        p::TimelineItem::User(user) => TimelineItem::User {
            id: user.id.clone(),
            text: user.text.clone(),
            author: user.author.clone().map(Into::into),
            sent_at: user.sent_at,
            client_id: user.client_id.clone(),
            request_id: user.request_id.clone(),
            private_to: user.private_to.clone().map(Into::into),
        },
        p::TimelineItem::Nudge(nudge) => TimelineItem::Nudge {
            id: nudge.id.clone(),
            text: nudge.text.clone(),
            fired_at: nudge.fired_at,
            private_to: nudge.private_to.clone().map(Into::into),
        },
        p::TimelineItem::Approval(approval) => TimelineItem::Approval {
            id: approval.id.clone(),
            approval_id: approval.approval_id.clone(),
            summary: approval.summary.clone(),
            status: approval.status.into(),
            decided_by: approval.decided_by.clone(),
            private_to: approval.private_to.clone().map(Into::into),
        },
        p::TimelineItem::Answer(answer) => TimelineItem::Answer {
            id: answer.id.clone(),
            status: match answer.status {
                p::AnswerStatus::Running => AnswerStatus::Running,
                p::AnswerStatus::Done => AnswerStatus::Done,
                p::AnswerStatus::Stopped => AnswerStatus::Stopped,
                p::AnswerStatus::Failed => AnswerStatus::Failed,
            },
            error: answer.error.clone(),
            parts: answer.parts.iter().filter_map(part).collect(),
            started_at: answer.started_at,
            prompted_by: match answer.prompted_by {
                Some(p::PromptedBy::Nudge) => Some(PromptedBy::Nudge),
                Some(p::PromptedBy::Watch) => Some(PromptedBy::Watch),
                Some(p::PromptedBy::Unknown) | None => None,
            },
            private_to: answer.private_to.clone().map(Into::into),
        },
        p::TimelineItem::Marker(marker) => TimelineItem::Marker {
            id: marker.id.clone(),
            kind: match marker.kind {
                p::MarkerKind::Compacted => MarkerKind::Compacted,
                p::MarkerKind::Reset => MarkerKind::Reset,
            },
        },
        p::TimelineItem::Unknown => return None,
    })
}

pub fn live(live: &p::Live) -> Live {
    Live {
        running: live.running,
        status: live.status.as_ref().and_then(|status| match status {
            p::Status::Retrying { attempt, at, error } => Some(Status::Retrying {
                attempt: *attempt,
                at: *at,
                error: error.clone(),
            }),
            p::Status::Compacting => Some(Status::Compacting),
            p::Status::CompactionFailed { error } => Some(Status::CompactionFailed {
                error: error.clone(),
            }),
            p::Status::Unknown => None,
        }),
    }
}

impl From<p::QueuedMessage> for QueuedMessage {
    fn from(queued: p::QueuedMessage) -> Self {
        QueuedMessage {
            id: queued.id,
            mode: match queued.mode {
                p::QueueMode::Steer => QueueMode::Steer,
                p::QueueMode::FollowUp => QueueMode::FollowUp,
            },
            text: queued.text,
            author: queued.author.map(Into::into),
            client_id: queued.client_id,
            request_id: queued.request_id,
            nudge: queued.nudge,
            private_to: queued.private_to.map(Into::into),
        }
    }
}

impl From<p::Approval> for Approval {
    fn from(approval: p::Approval) -> Self {
        Approval {
            id: approval.id,
            summary: approval.summary,
            status: approval.status.into(),
            requested_at: approval.requested_at,
            decided_by: approval.decided_by.map(Into::into),
            decided_at: approval.decided_at,
            result: approval.result,
            private_to: approval.private_to.map(Into::into),
        }
    }
}

impl From<p::Fact> for Fact {
    fn from(fact: p::Fact) -> Self {
        Fact {
            id: fact.id,
            text: fact.text,
            created_at: fact.created_at,
            by: fact.by.map(Into::into),
            owner: fact.owner.map(Into::into),
            private_to: fact.private_to.map(Into::into),
        }
    }
}

impl From<p::PlayerMemoryResponse> for PlayerMemory {
    fn from(memory: p::PlayerMemoryResponse) -> Self {
        PlayerMemory {
            facts: memory.facts.into_iter().map(Into::into).collect(),
            shared: memory.shared,
        }
    }
}

impl From<p::RoomExtension> for RoomExtension {
    fn from(extension: p::RoomExtension) -> Self {
        RoomExtension {
            name: extension.name,
            version: extension.version,
            description: extension.description,
            enabled: extension.enabled,
            by_default: extension.by_default,
        }
    }
}

impl From<p::RoomNudge> for RoomNudge {
    fn from(nudge: p::RoomNudge) -> Self {
        RoomNudge {
            id: nudge.id,
            message: nudge.message,
            fire_at: nudge.fire_at,
            every: nudge.every,
            private_to: nudge.private_to.map(Into::into),
        }
    }
}

impl From<p::RoomListView> for RoomListView {
    fn from(list: p::RoomListView) -> Self {
        RoomListView {
            player: list.player.into(),
            rooms: list
                .rooms
                .into_iter()
                .map(|row| RoomListEntry {
                    room: row.room.into(),
                    running: row.running,
                    pending_approvals: row.pending_approvals,
                    last_item_at: row.last_item_at,
                })
                .collect(),
            nudges: list
                .nudges
                .into_iter()
                .map(|nudge| RoomListNudge {
                    id: nudge.id,
                    room_id: nudge.room_id,
                    message: nudge.message,
                    fire_at: nudge.fire_at,
                    every: nudge.every,
                    private_to: nudge.private_to.map(Into::into),
                })
                .collect(),
            appearance: list.appearance.map(Into::into),
        }
    }
}

impl From<WhenBusy> for p::WhenBusy {
    fn from(when_busy: WhenBusy) -> Self {
        match when_busy {
            WhenBusy::FollowUp => p::WhenBusy::FollowUp,
            WhenBusy::Steer => p::WhenBusy::Steer,
            WhenBusy::Reject => p::WhenBusy::Reject,
        }
    }
}

impl From<p::WhenBusy> for WhenBusy {
    fn from(when_busy: p::WhenBusy) -> Self {
        match when_busy {
            p::WhenBusy::FollowUp => WhenBusy::FollowUp,
            p::WhenBusy::Steer => WhenBusy::Steer,
            p::WhenBusy::Reject => WhenBusy::Reject,
        }
    }
}

impl From<nudge_client::SyncStatus> for SyncStatus {
    fn from(status: nudge_client::SyncStatus) -> Self {
        match status {
            nudge_client::SyncStatus::Syncing => SyncStatus::Syncing,
            nudge_client::SyncStatus::Live => SyncStatus::Live,
            nudge_client::SyncStatus::Gone => SyncStatus::Gone,
        }
    }
}

impl From<p::UnsubscribedReason> for GoneReason {
    fn from(reason: p::UnsubscribedReason) -> Self {
        match reason {
            p::UnsubscribedReason::NotFound => GoneReason::NotFound,
            p::UnsubscribedReason::Removed => GoneReason::Removed,
        }
    }
}

impl From<&nudge_client::PendingMessage> for PendingMessage {
    fn from(message: &nudge_client::PendingMessage) -> Self {
        PendingMessage {
            request_id: message.request_id.clone(),
            text: message.text.clone(),
            when_busy: message.when_busy.map(Into::into),
            private: message.private,
            state: match &message.state {
                nudge_client::PendingState::Sending => PendingState::Sending,
                nudge_client::PendingState::Waiting { error } => PendingState::Waiting {
                    error: error.clone(),
                },
                nudge_client::PendingState::Failed { error } => PendingState::Failed {
                    error: error.clone(),
                },
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum DevicePlatform {
    Apns,
    Fcm,
}

/// Apps built for development take APNs pushes through Apple's sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PushEnvironment {
    Production,
    Sandbox,
}

/// Which native pushes the server sends, and the push relays it sends through.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PushPlatforms {
    pub apns: bool,
    pub fcm: bool,
    pub relays: Vec<String>,
}

/// The device's X25519 key pair for pushes through a relay, each half 32 bytes in base64url.
/// Keep the private half in the keychain or the app's private storage.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DeviceKey {
    pub public_key: String,
    pub private_key: String,
}

/// A push from a relay, once the device opened it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PushPayload {
    pub assistant: String,
    pub room_id: String,
    /// `answer` or `approval`.
    pub kind: String,
    /// The room's page, from the site's root: `/<assistant>/<room>`.
    pub url: String,
    pub title: String,
    pub body: String,
    /// The same for every push of a room, so a newer one replaces the older.
    pub tag: String,
    /// The sign-in it is for, as `NudgeClient::push_account`; absent from servers before it.
    pub account: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ModelRole {
    System,
    User,
    Assistant,
    ToolResult,
}

/// One message of a room's conversation as the model got it, placeholders and all.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ModelMessage {
    pub role: ModelRole,
    pub text: String,
}

/// One month's model spend, in US dollars.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct MonthUsage {
    /// `YYYY-MM`.
    pub month: String,
    pub total: f64,
    /// By player id.
    pub players: HashMap<String, f64>,
    /// By room id.
    pub rooms: HashMap<String, f64>,
}

/// This month's model spend and the limits; `months` for admins only.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Usage {
    pub month: String,
    pub total: f64,
    /// What answering the caller's messages cost this month.
    pub mine: f64,
    pub monthly_usd: Option<f64>,
    pub per_player_usd: Option<f64>,
    pub months: Vec<MonthUsage>,
}

impl From<DevicePlatform> for p::DevicePlatform {
    fn from(platform: DevicePlatform) -> Self {
        match platform {
            DevicePlatform::Apns => p::DevicePlatform::Apns,
            DevicePlatform::Fcm => p::DevicePlatform::Fcm,
        }
    }
}

impl From<PushEnvironment> for p::PushEnvironment {
    fn from(environment: PushEnvironment) -> Self {
        match environment {
            PushEnvironment::Production => p::PushEnvironment::Production,
            PushEnvironment::Sandbox => p::PushEnvironment::Sandbox,
        }
    }
}

impl From<p::ModelMessage> for ModelMessage {
    fn from(message: p::ModelMessage) -> Self {
        ModelMessage {
            role: match message.role {
                p::ModelRole::System => ModelRole::System,
                p::ModelRole::User => ModelRole::User,
                p::ModelRole::Assistant => ModelRole::Assistant,
                p::ModelRole::ToolResult => ModelRole::ToolResult,
            },
            text: message.text,
        }
    }
}

impl From<p::UsageResponse> for Usage {
    fn from(usage: p::UsageResponse) -> Self {
        Usage {
            month: usage.month,
            total: usage.total,
            mine: usage.mine,
            monthly_usd: usage.budget.monthly_usd,
            per_player_usd: usage.budget.per_player_usd,
            months: usage
                .months
                .unwrap_or_default()
                .into_iter()
                .map(|month| MonthUsage {
                    month: month.month,
                    total: month.total,
                    players: month.players.into_iter().collect(),
                    rooms: month.rooms.into_iter().collect(),
                })
                .collect(),
        }
    }
}

/// What a player says about themselves; their home keeps it and sends it to assistants they
/// joined. Extensions' preferences cross as a JSON string.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Profile {
    pub display_name: String,
    /// A `data:image/…;base64,` URL of at most 64 KiB.
    pub avatar: Option<String>,
    /// IANA, such as `Europe/Oslo`; the assistant's when absent.
    pub time_zone: Option<String>,
    /// BCP 47, such as `nb`: the assistant answers the player in it.
    pub language: Option<String>,
    pub notifications: Notifications,
    /// Each extension's preferences for the player, a JSON object by extension name.
    pub extensions_json: String,
}

/// Which pushes a player gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct Notifications {
    /// For finished answers.
    pub answers: bool,
    /// For actions waiting for approval.
    pub approvals: bool,
}

impl From<p::Profile> for Profile {
    fn from(profile: p::Profile) -> Self {
        let notifications = profile.notifications.unwrap_or_default();
        Profile {
            display_name: profile.display_name,
            avatar: profile.avatar,
            time_zone: profile.time_zone,
            language: profile.language,
            notifications: Notifications {
                answers: notifications.answers != Some(false),
                approvals: notifications.approvals != Some(false),
            },
            extensions_json: serde_json::to_string(&profile.extensions.unwrap_or_default())
                .expect("JSON values serialize"),
        }
    }
}

/// The fields of a profile to change; absent ones stay, and an empty string clears one.
#[derive(Clone, Debug, Default, PartialEq, uniffi::Record)]
pub struct ProfileUpdate {
    #[uniffi(default = None)]
    pub display_name: Option<String>,
    #[uniffi(default = None)]
    pub avatar: Option<String>,
    #[uniffi(default = None)]
    pub time_zone: Option<String>,
    #[uniffi(default = None)]
    pub language: Option<String>,
    #[uniffi(default = None)]
    pub notifications: Option<Notifications>,
    /// A JSON object by extension name: each one named is replaced, `null` clears it.
    #[uniffi(default = None)]
    pub extensions_json: Option<String>,
}

/// An installed extension that takes settings from each player; `schema_json` is JSON Schema.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PlayerSettings {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub schema_json: String,
}

impl From<p::PlayerSettingsSchema> for PlayerSettings {
    fn from(settings: p::PlayerSettingsSchema) -> Self {
        PlayerSettings {
            name: settings.name,
            version: settings.version,
            description: settings.description,
            schema_json: settings.schema.to_string(),
        }
    }
}

/// An assistant the player joined from their home; `carry_memory` once they allowed it.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Membership {
    pub server: String,
    pub assistant: String,
    pub since: f64,
    pub carry_memory: bool,
}

impl From<p::Membership> for Membership {
    fn from(membership: p::Membership) -> Self {
        Membership {
            server: membership.server,
            assistant: membership.assistant,
            since: membership.since,
            carry_memory: membership.carry_memory,
        }
    }
}

/// A server the player owns, as their home keeps it (ADR 11).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct OwnedServer {
    pub server: String,
    pub since: f64,
}

impl From<p::OwnedServer> for OwnedServer {
    fn from(owned: p::OwnedServer) -> Self {
        OwnedServer {
            server: owned.server,
            since: owned.since,
        }
    }
}

/// Where the player joined from here, their home, and their address to give to admins elsewhere.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Memberships {
    /// Such as `vegard@nudge.example.com/robin`.
    pub address: String,
    pub memberships: Vec<Membership>,
}

impl From<p::MembershipsResponse> for Memberships {
    fn from(response: p::MembershipsResponse) -> Self {
        Memberships {
            address: response.address,
            memberships: response.memberships.into_iter().map(Into::into).collect(),
        }
    }
}

/// Someone an admin asked to join, by their address; good for a week.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Invite {
    pub id: String,
    pub address: String,
    /// The admin's player id.
    pub by: String,
    pub created_at: f64,
    pub expires_at: f64,
}

impl From<p::Invite> for Invite {
    fn from(invite: p::Invite) -> Self {
        Invite {
            id: invite.id,
            address: invite.address,
            by: invite.by,
            created_at: invite.created_at,
            expires_at: invite.expires_at,
        }
    }
}

/// An invite, and the `nudge://join` link the invited person opens in their app.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct InviteLink {
    pub invite: Invite,
    pub link: String,
}
