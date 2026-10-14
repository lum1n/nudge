//! The protocol's shapes as UniFFI records and enums. Free-form JSON (a tool's args and details)
//! crosses as a JSON string, and times as milliseconds since the epoch.

use nudge_client::protocol as p;

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Player {
    pub id: String,
    pub display_name: String,
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
    },
    Nudge {
        id: String,
        text: String,
        fired_at: f64,
    },
    Approval {
        id: String,
        approval_id: String,
        summary: String,
        status: ApprovalStatus,
        decided_by: Option<String>,
    },
    Answer {
        id: String,
        status: AnswerStatus,
        error: Option<String>,
        parts: Vec<Part>,
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
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RoomNudge {
    pub id: String,
    pub message: String,
    pub fire_at: f64,
    pub every: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HomeRoom {
    pub room: Room,
    pub running: bool,
    pub pending_approvals: u32,
    pub last_item_at: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HomeNudge {
    pub id: String,
    pub room_id: String,
    pub message: String,
    pub fire_at: f64,
    pub every: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HomeView {
    pub player: Player,
    pub rooms: Vec<HomeRoom>,
    pub nudges: Vec<HomeNudge>,
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
        }
    }
}

impl From<p::Room> for Room {
    fn from(room: p::Room) -> Self {
        Room {
            id: room.id,
            kind: match room.kind {
                p::RoomKind::Lobby => RoomKind::Lobby,
                p::RoomKind::Personal => RoomKind::Personal,
                p::RoomKind::Shared => RoomKind::Shared,
            },
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
        },
        p::TimelineItem::Nudge(nudge) => TimelineItem::Nudge {
            id: nudge.id.clone(),
            text: nudge.text.clone(),
            fired_at: nudge.fired_at,
        },
        p::TimelineItem::Approval(approval) => TimelineItem::Approval {
            id: approval.id.clone(),
            approval_id: approval.approval_id.clone(),
            summary: approval.summary.clone(),
            status: approval.status.into(),
            decided_by: approval.decided_by.clone(),
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
        }
    }
}

impl From<p::HomeView> for HomeView {
    fn from(home: p::HomeView) -> Self {
        HomeView {
            player: home.player.into(),
            rooms: home
                .rooms
                .into_iter()
                .map(|row| HomeRoom {
                    room: row.room.into(),
                    running: row.running,
                    pending_approvals: row.pending_approvals,
                    last_item_at: row.last_item_at,
                })
                .collect(),
            nudges: home
                .nudges
                .into_iter()
                .map(|nudge| HomeNudge {
                    id: nudge.id,
                    room_id: nudge.room_id,
                    message: nudge.message,
                    fire_at: nudge.fire_at,
                    every: nudge.every,
                })
                .collect(),
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
