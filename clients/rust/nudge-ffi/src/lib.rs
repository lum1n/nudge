//! `nudge-client` for Swift, Kotlin and Python, through UniFFI. A `NudgeClient` runs on a Tokio
//! runtime of this library's own, so apps need none; its async methods can be awaited from any
//! executor. Views are observed with listeners, called on one of the library's threads (an app
//! hands the update to its UI thread): the room's timeline arrives as changes rather than whole,
//! at most about 30 times a second, so a streaming answer costs one `Set` per update.

mod diff;
mod types;

use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, UNIX_EPOCH};

use nudge_client::protocol as p;
use nudge_client::{ApiError, ClientError, Lease, RoomStore, SendOptions};
use tokio::runtime::Runtime;
use tokio::task::AbortHandle;

pub use diff::Change;
pub use types::*;

uniffi::setup_scaffolding!();

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("nudge")
        .enable_all()
        .build()
        .expect("a Tokio runtime starts")
});

/// The longest a listener waits for the next update while things change.
const UPDATE_EVERY: Duration = Duration::from_millis(33);

/// Runs `future` on the library's runtime, whatever executor awaits the result.
async fn run<T: Send + 'static>(future: impl Future<Output = T> + Send + 'static) -> T {
    RUNTIME
        .spawn(future)
        .await
        .expect("client tasks don't panic")
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
// Fields aren't called `message`: Kotlin's exceptions have one already.
pub enum NudgeError {
    /// The server answered with an error: 400 bad request, 401 no or unknown token (or a bad
    /// pairing code), 403 not an admin, 404 no such room or thing, 409 decided already.
    #[error("{detail} ({status})")]
    Status { status: u16, detail: String },
    /// No answer: the server is down or the network is gone.
    #[error("{detail}")]
    Network { detail: String },
    /// An answer this client couldn't read.
    #[error("{detail}")]
    Decode { detail: String },
    /// A bad server address, or a cache that won't open.
    #[error("{detail}")]
    Config { detail: String },
}

impl From<ApiError> for NudgeError {
    fn from(error: ApiError) -> Self {
        match error {
            ApiError::Status { status, message } => NudgeError::Status {
                status,
                detail: message,
            },
            ApiError::Network(detail) => NudgeError::Network { detail },
            ApiError::Decode(detail) => NudgeError::Decode { detail },
            ApiError::Address(_) => NudgeError::Config {
                detail: error.to_string(),
            },
        }
    }
}

impl From<ClientError> for NudgeError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Api(error) => error.into(),
            ClientError::Cache(error) => NudgeError::Config {
                detail: error.to_string(),
            },
        }
    }
}

/// Where the app keeps the token: the keychain, encrypted preferences, a file. `pair` stores
/// the token it gets here, and every request and connection attempt reads it again.
#[uniffi::export(with_foreign)]
pub trait TokenStore: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, token: Option<String>);
}

struct ForeignTokens(Arc<dyn TokenStore>);

impl nudge_client::TokenStore for ForeignTokens {
    fn get(&self) -> Option<String> {
        self.0.get()
    }

    fn set(&self, token: Option<String>) {
        self.0.set(token)
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct ClientConfig {
    /// The server's address, such as `https://nudge.example`.
    pub server: String,
    pub assistant: String,
    /// What this client is, such as `nudge-ios`; sent when signing in and pairing.
    pub client_name: String,
    pub client_version: String,
    /// Such as `ios`, `android`, `macos`, `python`.
    pub platform: String,
    /// A file for views and the outbox between runs; in memory only without one.
    pub cache_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum ConnectionStatus {
    /// Opening a socket, or waiting for the welcome.
    Connecting { attempt: u32 },
    Open {
        player: Player,
        client_id: String,
        server_version: String,
    },
    /// Lost, and trying again at `retry_at` (ms since the epoch).
    Waiting {
        attempt: u32,
        retry_at: f64,
        code: u16,
    },
    /// Given up: closed (1000), no, unknown or revoked token (4401), a frame the server didn't
    /// take (4400), or no such assistant (4404).
    Closed { code: u16, reason: String },
}

impl From<nudge_client::ConnectionStatus> for ConnectionStatus {
    fn from(status: nudge_client::ConnectionStatus) -> Self {
        match status {
            nudge_client::ConnectionStatus::Connecting { attempt } => {
                ConnectionStatus::Connecting { attempt }
            }
            nudge_client::ConnectionStatus::Open { welcome } => ConnectionStatus::Open {
                player: welcome.player.into(),
                client_id: welcome.client_id,
                server_version: welcome.server.version,
            },
            nudge_client::ConnectionStatus::Waiting {
                attempt,
                retry_at,
                code,
            } => ConnectionStatus::Waiting {
                attempt,
                retry_at: retry_at
                    .duration_since(UNIX_EPOCH)
                    .map_or(0.0, |d| d.as_millis() as f64),
                code,
            },
            nudge_client::ConnectionStatus::Closed { code, reason } => {
                ConnectionStatus::Closed { code, reason }
            }
        }
    }
}

/// A change to the timeline: apply them in order to the list from the updates before.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum TimelineChange {
    Reset { items: Vec<TimelineItem> },
    Append { items: Vec<TimelineItem> },
    Insert { index: u32, item: TimelineItem },
    Set { index: u32, item: TimelineItem },
    Remove { index: u32 },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HomeUpdate {
    pub status: SyncStatus,
    /// The latest view; also while syncing, and the cached one before the first snapshot.
    pub view: Option<HomeView>,
    pub reason: Option<GoneReason>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RoomUpdate {
    pub status: SyncStatus,
    pub reason: Option<GoneReason>,
    pub error: Option<String>,
    /// The rest of the room view, absent until there is one.
    pub room: Option<Room>,
    pub live: Option<Live>,
    pub queue: Vec<QueuedMessage>,
    pub approvals: Vec<Approval>,
    pub memory: Vec<Fact>,
    pub nudges: Vec<RoomNudge>,
    /// Changes to the timeline: earlier items, then the view's, oldest first.
    pub timeline: Vec<TimelineChange>,
    pub can_load_earlier: bool,
    pub loading_earlier: bool,
    pub earlier_error: Option<String>,
    /// Messages this client sent that the timeline doesn't show yet, oldest first.
    pub pending: Vec<PendingMessage>,
}

#[uniffi::export(with_foreign)]
pub trait ConnectionListener: Send + Sync {
    fn on_status(&self, status: ConnectionStatus);
}

#[uniffi::export(with_foreign)]
pub trait HomeListener: Send + Sync {
    fn on_update(&self, update: HomeUpdate);
}

#[uniffi::export(with_foreign)]
pub trait RoomListener: Send + Sync {
    fn on_update(&self, update: RoomUpdate);
}

/// A listener at work; `cancel` it, or drop it, to stop.
#[derive(uniffi::Object)]
pub struct Subscription {
    task: AbortHandle,
}

#[uniffi::export]
impl Subscription {
    pub fn cancel(&self) {
        self.task.abort();
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A room listener at work, which can also load the room's earlier items.
#[derive(uniffi::Object)]
pub struct RoomSubscription {
    task: AbortHandle,
    store: Arc<RoomStore>,
}

#[uniffi::export]
impl RoomSubscription {
    pub fn cancel(&self) {
        self.task.abort();
    }

    /// Fetches the page before the earliest item; the next update has it.
    pub async fn load_earlier(&self, limit: Option<u32>) {
        let store = self.store.clone();
        run(async move { store.load_earlier(limit).await }).await;
    }
}

impl Drop for RoomSubscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PanelStatus {
    /// Opening the socket, or waiting for `ready`; also after it dropped, until it is back.
    Connecting,
    Open,
    /// Given up: closed (1000), a bad token (4401), or no such room or extension socket (4404).
    Closed {
        code: u16,
        reason: String,
    },
}

/// Hears an extension panel's socket, on one of the library's threads.
#[uniffi::export(with_foreign)]
pub trait PanelListener: Send + Sync {
    fn on_status(&self, status: PanelStatus);
    /// A frame of the extension's own, as JSON: its view, `ok` and `error` replies, …
    fn on_frame(&self, json: String);
}

struct ForeignPanelListener(Arc<dyn PanelListener>);

impl nudge_client::PanelListener for ForeignPanelListener {
    fn status(&self, status: nudge_client::PanelStatus) {
        self.0.on_status(match status {
            nudge_client::PanelStatus::Connecting => PanelStatus::Connecting,
            nudge_client::PanelStatus::Open => PanelStatus::Open,
            nudge_client::PanelStatus::Closed { code, reason } => {
                PanelStatus::Closed { code, reason }
            }
        });
    }

    fn frame(&self, frame: serde_json::Value) {
        self.0.on_frame(frame.to_string());
    }
}

/// A room's socket to an extension's panel, such as `lists` or `documents`. It reconnects on its
/// own; `disconnect` it, or drop it, when done.
#[derive(uniffi::Object)]
pub struct Panel {
    socket: nudge_client::PanelSocket,
}

#[uniffi::export]
impl Panel {
    /// Sends one of the extension's input frames, as JSON; dropped while the socket isn't open.
    pub fn send(&self, json: String) -> Result<(), NudgeError> {
        let frame: serde_json::Value =
            serde_json::from_str(&json).map_err(|error| NudgeError::Decode {
                detail: error.to_string(),
            })?;
        self.socket.send(&frame);
        Ok(())
    }

    // Not `close`: the bindings' objects have a `close` that frees them.
    pub fn disconnect(&self) {
        self.socket.close();
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct TokenInfo {
    pub client_id: String,
    pub player_id: String,
    pub created_at: f64,
    pub client_name: Option<String>,
    pub client_platform: Option<String>,
}

/// The assistants `server` hosts; needs no token.
#[uniffi::export]
pub async fn list_assistants(server: String) -> Result<Vec<Assistant>, NudgeError> {
    let response = run(async move { nudge_client::list_assistants(&server).await }).await?;
    Ok(response
        .assistants
        .into_iter()
        .map(|a| Assistant {
            name: a.name,
            display_name: a.display_name,
        })
        .collect())
}

/// A client of one assistant: its commands, its socket, the views it observes, and an outbox
/// that sends what didn't get through once the socket is open, also after a restart.
#[derive(uniffi::Object)]
pub struct NudgeClient {
    client: nudge_client::NudgeClient,
    info: p::ClientInfo,
}

#[uniffi::export]
impl NudgeClient {
    #[uniffi::constructor]
    pub fn new(config: ClientConfig, tokens: Arc<dyn TokenStore>) -> Result<Arc<Self>, NudgeError> {
        let _runtime = RUNTIME.enter();
        let description = p::ClientDescription {
            name: config.client_name.clone(),
            version: config.client_version,
            platform: config.platform.clone(),
        };
        let mut options =
            nudge_client::ClientConfig::new(&config.server, &config.assistant, description);
        options.cache = config.cache_path.map(Into::into);
        let client = nudge_client::NudgeClient::new(options, Arc::new(ForeignTokens(tokens)))?;
        let info = p::ClientInfo {
            name: config.client_name,
            platform: config.platform,
        };
        Ok(Arc::new(NudgeClient { client, info }))
    }

    // `connect` and `disconnect` rather than `open` and `close`: the bindings' objects have a
    // `close` that frees them.

    /// Opens the socket; observed views are subscribed once it is open.
    pub fn connect(&self) {
        self.client.open();
    }

    /// Closes the socket; observers stay, and are subscribed again by `connect()`.
    pub fn disconnect(&self) {
        self.client.close();
    }

    /// Reconnects at once when waiting to retry, such as when the network comes back.
    pub fn retry_now(&self) {
        self.client.connection().retry_now();
    }

    pub fn connection_status(&self) -> ConnectionStatus {
        self.client.connection().status().into()
    }

    /// Hears the connection's status now and on every change.
    pub fn observe_connection(&self, listener: Arc<dyn ConnectionListener>) -> Arc<Subscription> {
        let mut statuses = self.client.connection().statuses();
        let task = RUNTIME.spawn(async move {
            loop {
                let status = statuses.borrow_and_update().clone();
                listener.on_status(status.into());
                if statuses.changed().await.is_err() {
                    return;
                }
            }
        });
        Arc::new(Subscription {
            task: task.abort_handle(),
        })
    }

    /// Follows the player's home view until the subscription is dropped.
    pub fn observe_home(&self, listener: Arc<dyn HomeListener>) -> Arc<Subscription> {
        let _runtime = RUNTIME.enter();
        let lease = self.client.home();
        let task = RUNTIME.spawn(async move {
            let mut states = lease.states();
            loop {
                let state = states.borrow_and_update().clone();
                listener.on_update(HomeUpdate {
                    status: state.status.into(),
                    view: state.view.as_deref().cloned().map(Into::into),
                    reason: state.reason.map(Into::into),
                    error: state.error.clone(),
                });
                tokio::time::sleep(UPDATE_EVERY).await;
                if states.changed().await.is_err() {
                    return;
                }
            }
        });
        Arc::new(Subscription {
            task: task.abort_handle(),
        })
    }

    /// Follows a room until the subscription is dropped. The first update resets the timeline.
    pub fn observe_room(
        &self,
        room: String,
        listener: Arc<dyn RoomListener>,
    ) -> Arc<RoomSubscription> {
        let _runtime = RUNTIME.enter();
        let lease = self.client.room(&room);
        let store = lease.store().clone();
        let task = RUNTIME.spawn(follow_room(lease, listener));
        Arc::new(RoomSubscription {
            task: task.abort_handle(),
            store,
        })
    }

    /// Trades a pairing code for a token, and stores it. A socket that gave up for want of a
    /// token connects again.
    pub async fn pair(&self, code: String) -> Result<Paired, NudgeError> {
        let (api, info) = (self.client.api().clone(), self.info.clone());
        let paired = run(async move { api.pair(&code, info).await }).await?;
        if let nudge_client::ConnectionStatus::Closed {
            code: p::close::UNAUTHORIZED,
            ..
        } = self.client.connection().status()
        {
            self.client.open();
        }
        Ok(Paired {
            client_id: paired.client_id,
            player: paired.player.into(),
        })
    }

    pub async fn me(&self) -> Result<MeInfo, NudgeError> {
        let api = self.client.api().clone();
        let me = run(async move { api.me().await }).await?;
        Ok(MeInfo {
            player: me.player.into(),
            client_id: me.client_id,
            admin: me.admin,
        })
    }

    /// A shared room with the caller and `members` (player ids).
    pub async fn create_room(
        &self,
        name: String,
        members: Vec<String>,
    ) -> Result<Room, NudgeError> {
        let api = self.client.api().clone();
        let body = p::CreateRoomRequest {
            name,
            members: Some(members),
        };
        Ok(run(async move { api.create_room(&body).await })
            .await?
            .into())
    }

    /// The caller's personal room, made on first use.
    pub async fn personal_room(&self) -> Result<Room, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.personal_room().await }).await?.into())
    }

    /// Sends a message, shown as pending in the room's updates until the timeline has it. With
    /// `private`, only this player sees it and the answer to it.
    #[uniffi::method(default(private = false))]
    pub async fn send(
        &self,
        room: String,
        text: String,
        when_busy: Option<WhenBusy>,
        private: bool,
    ) -> Result<Sent, NudgeError> {
        let client = self.client.clone();
        let options = SendOptions {
            when_busy: when_busy.map(Into::into),
            private,
            request_id: None,
        };
        let sent = run(async move { client.send(&room, &text, options).await }).await?;
        Ok(sent.into())
    }

    /// Sends a pending message again, with the same request id.
    pub async fn resend(&self, room: String, request_id: String) -> Result<Sent, NudgeError> {
        let client = self.client.clone();
        Ok(run(async move { client.resend(&room, &request_id).await })
            .await?
            .into())
    }

    /// Drops a pending message from the outbox and the room's updates.
    pub fn dismiss(&self, room: String, request_id: String) {
        self.client.dismiss(&room, &request_id);
    }

    /// Revokes this device's token on the server and forgets it; the socket closes with 4401.
    pub async fn sign_out(&self) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.sign_out().await }).await?)
    }

    /// Opens a room's socket to an extension's panel, such as `lists` or `documents`.
    pub fn open_panel(
        &self,
        room: String,
        extension: String,
        listener: Arc<dyn PanelListener>,
    ) -> Result<Arc<Panel>, NudgeError> {
        let _runtime = RUNTIME.enter();
        let socket =
            self.client
                .panel(&room, &extension, Arc::new(ForeignPanelListener(listener)))?;
        Ok(Arc::new(Panel { socket }))
    }

    /// Which native pushes the server sends; 404 when it sends no pushes at all.
    pub async fn push_platforms(&self) -> Result<PushPlatforms, NudgeError> {
        let api = self.client.api().clone();
        let platforms = run(async move { api.push_platforms().await }).await?;
        Ok(PushPlatforms {
            apns: platforms.apns,
            fcm: platforms.fcm,
        })
    }

    /// Has the server push to this device (an APNs device token in hex, or an FCM registration
    /// token) when one of the player's rooms has news and the app doesn't have it open.
    /// `environment` is for APNs: `Sandbox` for development builds. Call again when the token
    /// changes.
    pub async fn register_device(
        &self,
        platform: DevicePlatform,
        token: String,
        environment: Option<PushEnvironment>,
    ) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        let device = p::DeviceRequest {
            platform: platform.into(),
            token,
            environment: environment.map(Into::into),
        };
        Ok(run(async move { api.register_device(&device).await }).await?)
    }

    /// Stops pushes to this device, as when signing out.
    pub async fn unregister_device(&self, token: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.unregister_device(&token).await }).await?)
    }

    /// What the model saw in the room, as sent: placeholders, not the values.
    pub async fn model_view(&self, room: String) -> Result<Vec<ModelMessage>, NudgeError> {
        let api = self.client.api().clone();
        let view = run(async move { api.model_view(&room).await }).await?;
        Ok(view.messages.into_iter().map(Into::into).collect())
    }

    /// This month's model spend; every month, room and player for admins.
    pub async fn usage(&self) -> Result<Usage, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.usage().await }).await?.into())
    }

    /// Stops the answer in progress, and drops the room's queued messages.
    pub async fn abort(&self, room: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.abort(&room).await }).await?)
    }

    pub async fn remember(&self, room: String, text: String) -> Result<Fact, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.remember(&room, &text).await })
            .await?
            .into())
    }

    pub async fn forget(&self, room: String, fact_id: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.forget(&room, &fact_id).await }).await?)
    }

    /// The caller's own memory, and whether they share it with all their rooms.
    pub async fn my_memory(&self) -> Result<PlayerMemory, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.my_memory().await }).await?.into())
    }

    pub async fn remember_for_me(&self, text: String) -> Result<Fact, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.remember_for_me(&text).await })
            .await?
            .into())
    }

    pub async fn forget_for_me(&self, fact_id: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.forget_for_me(&fact_id).await }).await?)
    }

    /// With `shared`, everyone in the caller's rooms, and the model there, sees their own facts.
    pub async fn share_my_memory(&self, shared: bool) -> Result<PlayerMemory, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.share_my_memory(shared).await })
            .await?
            .into())
    }

    pub async fn room_extensions(&self, room: String) -> Result<Vec<RoomExtension>, NudgeError> {
        let api = self.client.api().clone();
        let extensions = run(async move { api.room_extensions(&room).await }).await?;
        Ok(extensions.into_iter().map(Into::into).collect())
    }

    /// Turns an extension on or off in the room; `None` goes back to the default for its kind.
    pub async fn set_room_extension(
        &self,
        room: String,
        extension: String,
        enabled: Option<bool>,
    ) -> Result<RoomExtension, NudgeError> {
        let api = self.client.api().clone();
        Ok(
            run(async move { api.set_room_extension(&room, &extension, enabled).await })
                .await?
                .into(),
        )
    }

    pub async fn decide(
        &self,
        room: String,
        approval_id: String,
        approve: bool,
    ) -> Result<Approval, NudgeError> {
        let api = self.client.api().clone();
        Ok(
            run(async move { api.decide(&room, &approval_id, approve).await })
                .await?
                .into(),
        )
    }

    pub async fn cancel_nudge(&self, nudge_id: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.cancel_nudge(&nudge_id).await }).await?)
    }

    /// A placeholder that stands for `value` in what the model sees. With `private`, everyone
    /// but this player sees the placeholder too, wherever the value shows.
    #[uniffi::method(default(private = false))]
    pub async fn protect(
        &self,
        value: String,
        kind: Option<String>,
        private: bool,
    ) -> Result<String, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.protect(&value, kind.as_deref(), private).await }).await?)
    }

    /// The values only this player sees.
    pub async fn private_values(&self) -> Result<Vec<PrivateValue>, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.private_values().await })
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Drops a value for good: from now on everyone, the model included, sees only `placeholder`.
    pub async fn forget_value(&self, placeholder: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.forget_value(&placeholder).await }).await?)
    }

    // Admin commands, for players with the admin flag.

    pub async fn create_player(&self, display_name: String) -> Result<Player, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.create_player(&display_name).await })
            .await?
            .into())
    }

    pub async fn pairing_code(&self, player_id: String) -> Result<PairingCode, NudgeError> {
        let api = self.client.api().clone();
        let code = run(async move { api.pairing_code(&player_id).await }).await?;
        Ok(PairingCode {
            code: code.code,
            link: code.link,
            expires_at: code.expires_at,
        })
    }

    pub async fn list_tokens(
        &self,
        player_id: Option<String>,
    ) -> Result<Vec<TokenInfo>, NudgeError> {
        let api = self.client.api().clone();
        let tokens = run(async move { api.list_tokens(player_id.as_deref()).await }).await?;
        Ok(tokens
            .into_iter()
            .map(|token| TokenInfo {
                client_id: token.client_id,
                player_id: token.player_id,
                created_at: token.created_at,
                client_name: token.client.as_ref().map(|c| c.name.clone()),
                client_platform: token.client.map(|c| c.platform),
            })
            .collect())
    }

    /// Revokes a client's token; its sockets close with 4401.
    pub async fn revoke(&self, client_id: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.revoke(&client_id).await }).await?)
    }
}

impl From<nudge_client::Sent> for Sent {
    fn from(sent: nudge_client::Sent) -> Self {
        match sent {
            nudge_client::Sent::Delivered(response) => Sent::Delivered {
                submission_id: response.submission_id,
            },
            nudge_client::Sent::Queued => Sent::Queued,
        }
    }
}

async fn follow_room(lease: Lease<RoomStore>, listener: Arc<dyn RoomListener>) {
    let mut states = lease.states();
    let mut shown: Vec<p::TimelineItem> = Vec::new();
    let mut first = true;
    loop {
        let state = states.borrow_and_update().clone();
        let timeline: Vec<p::TimelineItem> = state
            .timeline
            .iter()
            .filter(|item| item.id().is_some())
            .cloned()
            .collect();
        let changes = if first {
            vec![Change::Reset {
                values: timeline.clone(),
            }]
        } else {
            diff::changes(&shown, &timeline, |item| item.id().unwrap_or_default())
        };
        first = false;
        shown = timeline;
        listener.on_update(room_update(&state, changes));
        tokio::time::sleep(UPDATE_EVERY).await;
        if states.changed().await.is_err() {
            return;
        }
    }
}

fn room_update(
    state: &nudge_client::RoomState,
    changes: Vec<Change<p::TimelineItem>>,
) -> RoomUpdate {
    let items = |values: Vec<p::TimelineItem>| values.iter().filter_map(timeline_item).collect();
    let item = |value: &p::TimelineItem| timeline_item(value).expect("unknown items are left out");
    let view = state.view.as_deref();
    RoomUpdate {
        status: state.status.into(),
        reason: state.reason.map(Into::into),
        error: state.error.clone(),
        room: view.map(|view| view.room.clone().into()),
        live: view.map(|view| live(&view.live)),
        queue: view.map_or_else(Vec::new, |view| {
            view.queue.iter().cloned().map(Into::into).collect()
        }),
        approvals: view.map_or_else(Vec::new, |view| {
            view.approvals.iter().cloned().map(Into::into).collect()
        }),
        memory: view.map_or_else(Vec::new, |view| {
            view.memory.iter().cloned().map(Into::into).collect()
        }),
        nudges: view.map_or_else(Vec::new, |view| {
            view.nudges.iter().cloned().map(Into::into).collect()
        }),
        timeline: changes
            .into_iter()
            .map(|change| match change {
                Change::Reset { values } => TimelineChange::Reset {
                    items: items(values),
                },
                Change::Append { values } => TimelineChange::Append {
                    items: items(values),
                },
                Change::Insert { index, value } => TimelineChange::Insert {
                    index,
                    item: item(&value),
                },
                Change::Set { index, value } => TimelineChange::Set {
                    index,
                    item: item(&value),
                },
                Change::Remove { index } => TimelineChange::Remove { index },
            })
            .collect(),
        can_load_earlier: state.can_load_earlier,
        loading_earlier: state.loading_earlier,
        earlier_error: state.earlier_error.clone(),
        pending: state.pending.iter().map(Into::into).collect(),
    }
}
