//! `nudge-client` for Swift, Kotlin and Python, through UniFFI. A `NudgeClient` runs on a Tokio
//! runtime of this library's own, so apps need none; its async methods can be awaited from any
//! executor. Views are observed with listeners, called on one of the library's threads (an app
//! hands the update to its UI thread): the room's timeline arrives as changes rather than whole,
//! at most about 30 times a second, so a streaming answer costs one `Set` per update.

mod diff;
mod server;
#[cfg(feature = "speech")]
mod speech;
mod types;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, UNIX_EPOCH};

use nudge_client::protocol as p;
use nudge_client::{ApiError, ClientError, Lease, RoomStore, SendOptions};
use tokio::runtime::Runtime;
use tokio::task::AbortHandle;

pub use diff::Change;
pub use server::*;
#[cfg(feature = "speech")]
pub use speech::*;
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
            // Both are 429s whose detail says which; the core sends a rate-limited message again
            // by itself, and a budget-refused one waits for the person.
            ApiError::RateLimited { message, .. } | ApiError::BudgetSpent(message) => {
                NudgeError::Status {
                    status: 429,
                    detail: message,
                }
            }
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
pub struct RoomListUpdate {
    pub status: SyncStatus,
    /// The latest view; also while syncing, and the cached one before the first snapshot.
    pub view: Option<RoomListView>,
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
    /// The members whose location the model may know in the room.
    pub sharing_location: Vec<Player>,
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
pub trait RoomListListener: Send + Sync {
    fn on_update(&self, update: RoomListUpdate);
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
    pub last_used_at: Option<f64>,
    pub expires_at: Option<f64>,
}

/// A new key pair for this device's pushes through a relay; make one per install and keep it.
#[uniffi::export]
pub fn new_device_key() -> DeviceKey {
    let key = nudge_client::DeviceKey::generate();
    DeviceKey {
        public_key: key.public_key,
        private_key: key.private_key,
    }
}

/// What a relay's push says (its `sealed` field), if it was sealed for this device; `None` for
/// one that wasn't, which the app should show as it came or drop.
#[uniffi::export]
pub fn open_push(private_key: String, sealed: String) -> Option<PushPayload> {
    let push = nudge_client::open_push(&private_key, &sealed)?;
    Some(PushPayload {
        assistant: push.assistant,
        room_id: push.room_id,
        kind: push.kind,
        url: push.url,
        title: push.title,
        body: push.body,
        tag: push.tag,
        account: push.account,
    })
}

/// Registers the device's APNs or FCM token with a push relay and returns its handle, for
/// `register_relay_device` on each server. Needs no token.
#[uniffi::export]
pub async fn register_with_relay(
    relay: String,
    platform: DevicePlatform,
    token: String,
    environment: Option<PushEnvironment>,
) -> Result<String, NudgeError> {
    let (platform, environment) = (platform.into(), environment.map(Into::into));
    Ok(run(async move {
        nudge_client::register_with_relay(&relay, platform, &token, environment).await
    })
    .await?)
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
            appearance: a.appearance.map(Into::into),
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

    /// Follows the player's room list until the subscription is dropped.
    pub fn observe_room_list(&self, listener: Arc<dyn RoomListListener>) -> Arc<Subscription> {
        let _runtime = RUNTIME.enter();
        let lease = self.client.room_list();
        let task = RUNTIME.spawn(async move {
            let mut states = lease.states();
            loop {
                let state = states.borrow_and_update().clone();
                listener.on_update(RoomListUpdate {
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

    /// Signs in the browser whose QR code (a `nudge://sign-in` link) holds sign-in `request`, as
    /// this player. A 404 when it expired or was used, a 401 when this assistant doesn't know the
    /// token, as when the QR code is another server's.
    pub async fn approve_sign_in(&self, request: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.approve_sign_in(&request).await }).await?)
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

    /// The room keeps its id. Its owner or members may rename it, admins any room, the lobby too.
    pub async fn rename_room(&self, room: String, name: String) -> Result<Room, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.rename_room(&room, &name).await })
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

    /// The places the phone should watch for the player's arrival reminders, around where it is
    /// when given. Fails with 404 when the assistant has no places extension.
    pub async fn arrival_regions(
        &self,
        latitude: Option<f64>,
        longitude: Option<f64>,
    ) -> Result<ArrivalRegions, NudgeError> {
        let api = self.client.api().clone();
        let at = latitude.zip(longitude);
        let answer = run(async move { api.arrival_regions(at).await }).await?;
        let region = |r: p::ArrivalRegion| ArrivalRegion {
            id: r.id,
            latitude: r.latitude,
            longitude: r.longitude,
            radius: r.radius,
        };
        Ok(ArrivalRegions {
            version: answer.version as u64,
            regions: answer.regions.into_iter().map(region).collect(),
            refresh: answer.refresh.map(|r| ArrivalRegion {
                id: "refresh".into(),
                latitude: r.latitude,
                longitude: r.longitude,
                radius: r.radius,
            }),
        })
    }

    /// The phone got to (`entered`) or left a region from `arrival_regions`; answers how many
    /// reminders that set off.
    pub async fn report_region_event(
        &self,
        region_id: String,
        entered: bool,
    ) -> Result<u32, NudgeError> {
        let api = self.client.api().clone();
        let event = if entered {
            p::RegionEvent::Enter
        } else {
            p::RegionEvent::Exit
        };
        let answer = run(async move { api.report_region_event(&region_id, event).await }).await?;
        Ok(answer.fired as u32)
    }

    /// The player's saved places and arrival reminders.
    pub async fn places(&self) -> Result<Places, NudgeError> {
        let api = self.client.api().clone();
        let answer = run(async move { api.places().await }).await?;
        Ok(Places {
            places: answer
                .places
                .into_iter()
                .map(|place| SavedPlace {
                    name: place.name,
                    placeholder: place.placeholder,
                    address: place.address,
                    radius: place.radius,
                })
                .collect(),
            reminders: answer
                .reminders
                .into_iter()
                .map(|r| ArrivalReminder {
                    id: r.id,
                    room_id: r.room_id,
                    arrive: r.on == p::ArrivalOn::Arrive,
                    always: r.repeat == p::ArrivalRepeat::Always,
                    place: r.place,
                    kind: r.kind,
                    message: r.message,
                })
                .collect(),
        })
    }

    /// Forgets a saved place, by its name, and the reminders for it.
    pub async fn forget_place(&self, name: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.forget_place(&name).await }).await?)
    }

    pub async fn cancel_arrival_reminder(&self, id: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.cancel_arrival_reminder(&id).await }).await?)
    }

    /// Which native pushes the server sends; 404 when it sends no pushes at all.
    pub async fn push_platforms(&self) -> Result<PushPlatforms, NudgeError> {
        let api = self.client.api().clone();
        let platforms = run(async move { api.push_platforms().await }).await?;
        Ok(PushPlatforms {
            apns: platforms.apns,
            fcm: platforms.fcm,
            relays: platforms.relays,
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
        let device = p::DeviceRequest::Native(p::NativeDevice {
            platform: platform.into(),
            token,
            environment: environment.map(Into::into),
            account: None,
        });
        Ok(run(async move { api.register_device(&device).await }).await?)
    }

    /// Has the server push to this device through `relay`, one of `push_platforms().relays`,
    /// sealed for `device_key` (`new_device_key().public_key`). `handle` is what
    /// `register_with_relay` gave. Call again with a new handle when the token changes; the
    /// server knows the device by its key.
    pub async fn register_relay_device(
        &self,
        relay: String,
        handle: String,
        device_key: String,
    ) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        let device = p::DeviceRequest::Relay(p::RelayDevice {
            platform: p::RelayPlatform::Relay,
            relay,
            handle,
            device_key,
            account: None,
        });
        Ok(run(async move { api.register_device(&device).await }).await?)
    }

    /// What this client's pushes carry as `account`, given with every device it registers: the
    /// same for every client of this server and assistant, and different from any other, though
    /// their assistants share a name.
    pub fn push_account(&self) -> String {
        self.client.api().push_account()
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

    /// Approves or denies. `inputs` are the approval's inputs by name, sent only with a yes and
    /// never kept: clear the fields once it is sent.
    #[uniffi::method(default(inputs = None))]
    pub async fn decide(
        &self,
        room: String,
        approval_id: String,
        approve: bool,
        inputs: Option<HashMap<String, String>>,
    ) -> Result<Approval, NudgeError> {
        let api = self.client.api().clone();
        Ok(
            run(async move { api.decide(&room, &approval_id, approve, inputs).await })
                .await?
                .into(),
        )
    }

    /// Presses `button` on the card tool call `call_id` showed (ADR 27). `values_json` is a JSON
    /// object of the card's fields by name, left out for a button that skips them.
    #[uniffi::method(default(values_json = None))]
    pub async fn press_card(
        &self,
        room: String,
        call_id: String,
        button: String,
        values_json: Option<String>,
    ) -> Result<(), NudgeError> {
        let values = match values_json {
            None => None,
            Some(json) => match serde_json::from_str::<serde_json::Value>(&json) {
                Ok(serde_json::Value::Object(map)) => Some(map),
                _ => {
                    return Err(NudgeError::Decode {
                        detail: "values_json is not a JSON object".into(),
                    });
                }
            },
        };
        let api = self.client.api().clone();
        run(async move { api.press_card(&room, &call_id, &button, values).await }).await?;
        Ok(())
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

    /// The player's full name, e-mail, phone, address and location.
    pub async fn personal(&self) -> Result<PersonalDetails, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.personal().await }).await?.into())
    }

    /// Changes the details `update` sets; 400 for one that isn't one, such as an e-mail address.
    /// 403 for a player whose home is another assistant: their details stay there.
    pub async fn update_personal(
        &self,
        update: PersonalUpdate,
    ) -> Result<PersonalDetails, NudgeError> {
        let update = p::UpdatePersonalRequest {
            full_name: update.full_name.map(Some),
            email: update.email.map(Some),
            phone: update.phone.map(Some),
            address: update.address.map(Some),
            location: None,
        };
        let api = self.client.api().clone();
        Ok(run(async move { api.update_personal(&update).await })
            .await?
            .into())
    }

    /// Tells the assistant where the player is: coordinates, and the place the device named,
    /// such as a street address. A spot within 100 m of the last keeps its placeholder.
    pub async fn share_location(
        &self,
        latitude: f64,
        longitude: f64,
        place: Option<String>,
    ) -> Result<PersonalDetails, NudgeError> {
        let update = p::UpdatePersonalRequest {
            location: Some(Some(p::LocationRequest {
                latitude,
                longitude,
                place: place.filter(|place| !place.trim().is_empty()),
            })),
            ..Default::default()
        };
        let api = self.client.api().clone();
        Ok(run(async move { api.update_personal(&update).await })
            .await?
            .into())
    }

    /// Forgets where the player was; the assistant no longer knows their location.
    pub async fn forget_location(&self) -> Result<PersonalDetails, NudgeError> {
        let update = p::UpdatePersonalRequest {
            location: Some(None),
            ..Default::default()
        };
        let api = self.client.api().clone();
        Ok(run(async move { api.update_personal(&update).await })
            .await?
            .into())
    }

    /// Lets the model in a shared room know where the player is, for anyone there, or stops it.
    pub async fn share_location_in(
        &self,
        room: String,
        shared: bool,
    ) -> Result<PersonalDetails, NudgeError> {
        let api = self.client.api().clone();
        Ok(
            run(async move { api.share_location_in(&room, shared).await })
                .await?
                .into(),
        )
    }

    /// The player's profile: name, avatar, time zone, language and preferences.
    pub async fn profile(&self) -> Result<Profile, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.profile().await }).await?.into())
    }

    /// Changes the fields `update` sets; 400 for a value that isn't one, such as a time zone.
    pub async fn update_profile(&self, update: ProfileUpdate) -> Result<Profile, NudgeError> {
        let update = profile_update(update)?;
        let api = self.client.api().clone();
        Ok(run(async move { api.update_profile(&update).await })
            .await?
            .into())
    }

    /// The extensions that take settings from each player, for the profile's settings forms.
    pub async fn profile_extensions(&self) -> Result<Vec<PlayerSettings>, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.profile_extensions().await })
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    // Roaming, through the extension `federation`: 404 on an assistant without it. To join
    // another assistant, ask the home's client for an assertion with `vouch_for`, then pass it to
    // `join` on a client of the assistant joined.

    /// Has the player's home vouch for them to the assistant `assistant` at `server`: an
    /// assertion only that assistant can read, good for five minutes.
    pub async fn vouch_for(&self, server: String, assistant: String) -> Result<String, NudgeError> {
        let api = self.client.api().clone();
        let place = p::PlaceRequest { server, assistant };
        let sealed = run(async move { api.vouch_for(&place).await }).await?;
        Ok(serde_json::to_string(&sealed).expect("JSON values serialize"))
    }

    /// Joins this assistant with an assertion from `vouch_for`, and stores the token. A socket
    /// that gave up for want of a token connects again.
    pub async fn join(&self, assertion: String) -> Result<Paired, NudgeError> {
        let assertion: p::Sealed =
            serde_json::from_str(&assertion).map_err(|error| NudgeError::Decode {
                detail: format!("Not an assertion: {error}"),
            })?;
        let api = self.client.api().clone();
        let joined = run(async move { api.join(assertion).await }).await?;
        if let nudge_client::ConnectionStatus::Closed {
            code: p::close::UNAUTHORIZED,
            ..
        } = self.client.connection().status()
        {
            self.client.open();
        }
        Ok(Paired {
            client_id: joined.client_id,
            player: joined.player.into(),
        })
    }

    /// The assistants the player joined from here, their home, and the player's address.
    pub async fn memberships(&self) -> Result<Memberships, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.memberships().await }).await?.into())
    }

    /// Starts or stops carrying the player's own memory to an assistant they joined.
    pub async fn carry_memory(
        &self,
        server: String,
        assistant: String,
        carry: bool,
    ) -> Result<Membership, NudgeError> {
        let api = self.client.api().clone();
        let place = p::PlaceRequest { server, assistant };
        Ok(run(async move { api.carry_memory(&place, carry).await })
            .await?
            .into())
    }

    /// Stops sending the player's profile and memory to an assistant they joined.
    pub async fn leave(&self, server: String, assistant: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        let place = p::PlaceRequest { server, assistant };
        Ok(run(async move { api.leave(&place).await }).await?)
    }

    // The servers the player owns, kept at their home so all their devices see them (ADR 11). On
    // another device, `owner_assertion` and `ServerClient::sign_in_from_home` give a server token.

    /// The servers the player owns, as their home keeps them.
    pub async fn owned_servers(&self) -> Result<Vec<OwnedServer>, NudgeError> {
        let api = self.client.api().clone();
        let servers = run(async move { api.owned_servers().await }).await?;
        Ok(servers.into_iter().map(Into::into).collect())
    }

    /// Keeps a server the player owns at home.
    pub async fn add_owned_server(&self, server: String) -> Result<Vec<OwnedServer>, NudgeError> {
        let api = self.client.api().clone();
        let servers = run(async move { api.add_owned_server(&server).await }).await?;
        Ok(servers.into_iter().map(Into::into).collect())
    }

    /// Takes a server off the player's list at home; nothing on the server changes.
    pub async fn remove_owned_server(&self, server: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.remove_owned_server(&server).await }).await?)
    }

    /// Has the player's home vouch for them to a server they own, sealed for that server: an
    /// assertion for `ServerClient::sign_in_from_home`, good for five minutes.
    pub async fn owner_assertion(&self, server: String) -> Result<String, NudgeError> {
        let api = self.client.api().clone();
        let sealed = run(async move { api.owner_assertion(&server).await }).await?;
        Ok(serde_json::to_string(&sealed).expect("JSON values serialize"))
    }

    // Admin commands, for players with the admin flag.

    /// How the assistant's robot looks, for everyone; `None` goes back to the app icon's. The
    /// room list shows the change. A 400 for a colour, eye shape or accessory that isn't one.
    pub async fn set_appearance(
        &self,
        appearance: Option<Appearance>,
    ) -> Result<Option<Appearance>, NudgeError> {
        let api = self.client.api().clone();
        Ok(
            run(async move { api.set_appearance(appearance.map(Into::into)).await })
                .await?
                .map(Into::into),
        )
    }

    /// Gives a player the admin flag, or with `false` takes it; returns whether they have it now.
    pub async fn set_admin(&self, player_id: String, admin: bool) -> Result<bool, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.set_admin(&player_id, admin).await })
            .await?
            .admin)
    }

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

    /// Every room of the assistant, not only this player's, such as for settings that pick rooms.
    pub async fn all_rooms(&self) -> Result<Vec<Room>, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.all_rooms().await })
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
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
                last_used_at: token.last_used_at,
                expires_at: token.expires_at,
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

    /// Lets the person at `address` (`name@server/assistant`) join, for a week.
    pub async fn invite(&self, address: String) -> Result<InviteLink, NudgeError> {
        let api = self.client.api().clone();
        let invited = run(async move { api.invite(&address).await }).await?;
        Ok(InviteLink {
            invite: invited.invite.into(),
            link: invited.link,
        })
    }

    /// The open invites.
    pub async fn invites(&self) -> Result<Vec<Invite>, NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.invites().await })
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub async fn cancel_invite(&self, id: String) -> Result<(), NudgeError> {
        let api = self.client.api().clone();
        Ok(run(async move { api.cancel_invite(&id).await }).await?)
    }

    /// The assistant's extensions and the ones it could add, with their settings and schemas;
    /// 404 when the server can't set up extensions.
    pub async fn extension_setups(&self) -> Result<Vec<ExtensionSetup>, NudgeError> {
        let api = self.client.api().clone();
        let setups = run(async move { api.extension_setups().await }).await?;
        Ok(setups.into_iter().map(Into::into).collect())
    }

    /// Installs `extensions`, in order, in place of the assistant's, and keeps them in its
    /// config; ones left out are removed. 400, and nothing changed, when one won't start.
    pub async fn save_extension_setups(
        &self,
        extensions: Vec<SavedExtensionSetup>,
    ) -> Result<Vec<ExtensionSetup>, NudgeError> {
        let extensions = extensions
            .into_iter()
            .map(|setup| {
                let settings = match setup.settings_json {
                    None => None,
                    Some(json) => match serde_json::from_str(&json) {
                        Ok(serde_json::Value::Object(settings)) => Some(settings),
                        _ => {
                            return Err(NudgeError::Decode {
                                detail: format!(
                                    "The settings of {} are not a JSON object",
                                    setup.from
                                ),
                            });
                        }
                    },
                };
                Ok(p::SavedExtensionSetup {
                    from: setup.from,
                    enabled: setup.enabled,
                    settings,
                    rooms: setup
                        .rooms
                        .map(|rooms| rooms.into_iter().map(Into::into).collect()),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let api = self.client.api().clone();
        let setups = run(async move { api.save_extension_setups(extensions).await }).await?;
        Ok(setups.into_iter().map(Into::into).collect())
    }
}

/// An empty string clears a field; the extensions' JSON must be an object of objects or `null`s.
fn profile_update(update: ProfileUpdate) -> Result<p::UpdateProfileRequest, NudgeError> {
    let clearable = |value: Option<String>| value.map(|v| (!v.is_empty()).then_some(v));
    let notifications = update.notifications.map(|n| {
        Some(p::NotificationPrefs {
            answers: Some(n.answers),
            approvals: Some(n.approvals),
        })
    });
    let extensions = match update.extensions_json {
        None => None,
        Some(json) => Some(Some(serde_json::from_str(&json).map_err(|_| {
            NudgeError::Decode {
                detail: "The extensions' settings are not a JSON object of objects".into(),
            }
        })?)),
    };
    Ok(p::UpdateProfileRequest {
        display_name: update.display_name,
        avatar: clearable(update.avatar),
        time_zone: clearable(update.time_zone),
        language: clearable(update.language),
        notifications,
        extensions,
    })
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
        sharing_location: view
            .and_then(|view| view.sharing_location.clone())
            .map_or_else(Vec::new, |players| {
                players.into_iter().map(Into::into).collect()
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
