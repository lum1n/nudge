use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nudge_protocol::*;

use crate::api::{Api, ApiError, TokenStore};
use crate::cache::{Cache, CacheError, Outgoing};
use crate::connection::{
    Backoff, Connection, ConnectionOptions, ConnectionStatus, OnError, Watch, connect_url,
};
use crate::panel::{PanelListener, PanelSocket, panel_url};
use crate::stores::{HomeStore, PageLoader, PendingMessage, PendingState, RoomStore};

pub struct ClientConfig {
    /// The server's address, such as `https://nudge.example`.
    pub server: String,
    pub assistant: String,
    /// What this client is: sent in the socket's hello.
    pub client: ClientDescription,
    /// Where to keep views and the outbox between runs; in memory only without one.
    pub cache: Option<PathBuf>,
    pub backoff: Backoff,
    /// How long to wait for any frame before a ping, until the server says otherwise.
    pub heartbeat: Duration,
    /// `error` frames: the server couldn't use a frame.
    pub on_error: Option<OnError>,
}

impl ClientConfig {
    pub fn new(server: &str, assistant: &str, client: ClientDescription) -> Self {
        ClientConfig {
            server: server.to_owned(),
            assistant: assistant.to_owned(),
            client,
            cache: None,
            backoff: Backoff::default(),
            heartbeat: Duration::from_secs(25),
            on_error: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error(transparent)]
    Cache(#[from] CacheError),
}

/// How a message went.
#[derive(Clone, Debug, PartialEq)]
pub enum Sent {
    Delivered(MessageResponse),
    /// It didn't get through; it waits in the outbox and is sent again once the socket is open.
    Queued,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendOptions {
    pub when_busy: Option<WhenBusy>,
    /// Only the sender sees the message and the answer to it.
    pub private: bool,
    /// A fresh one when absent.
    pub request_id: Option<String>,
}

/// How often waiting messages are tried again while the socket is open.
const RETRY_EVERY: Duration = Duration::from_secs(10);

/// A client of one assistant: its HTTP commands (`api`), its socket (`connection`), the stores of
/// the views in use, shared by everyone who holds them, and an outbox. A view is subscribed while
/// at least one lease on it is held. `send` puts a message in the outbox and shows it in its
/// room's store until the view has it; a message that doesn't get through is sent again with the
/// same request id once the socket is open, also after a restart when the cache is on disk.
///
/// Make one inside a Tokio runtime; it runs tasks of its own until the last handle is dropped.
#[derive(Clone)]
pub struct NudgeClient {
    inner: Arc<Inner>,
}

struct Inner {
    api: Api,
    server: String,
    assistant: String,
    backoff: Backoff,
    connection: Connection,
    cache: Arc<Cache>,
    held: Mutex<HashMap<Target, Held>>,
    /// Request ids being posted now.
    posting: Mutex<HashSet<String>>,
}

struct Held {
    store: Store,
    leases: usize,
    _watch: Watch,
}

#[derive(Clone)]
enum Store {
    Home(Arc<HomeStore>),
    Room(Arc<RoomStore>),
}

/// A store held open; dropping the lease lets it go.
pub struct Lease<S> {
    store: Arc<S>,
    target: Target,
    client: Weak<Inner>,
}

impl<S> Deref for Lease<S> {
    type Target = S;

    fn deref(&self) -> &S {
        &self.store
    }
}

impl<S> Lease<S> {
    pub fn store(&self) -> &Arc<S> {
        &self.store
    }
}

impl<S> Drop for Lease<S> {
    fn drop(&mut self) {
        let Some(inner) = self.client.upgrade() else {
            return;
        };
        let mut held = inner.held.lock().unwrap();
        if let Some(entry) = held.get_mut(&self.target) {
            entry.leases -= 1;
            if entry.leases == 0 {
                held.remove(&self.target);
            }
        }
    }
}

impl NudgeClient {
    pub fn new(config: ClientConfig, tokens: Arc<dyn TokenStore>) -> Result<Self, ClientError> {
        let api = Api::new(&config.server, &config.assistant, tokens.clone())?;
        let cache = Arc::new(match &config.cache {
            Some(path) => Cache::open(path)?,
            None => Cache::in_memory(),
        });
        let connection = Connection::new(ConnectionOptions {
            url: connect_url(&config.server, &config.assistant)?,
            tokens,
            client: config.client,
            backoff: config.backoff,
            heartbeat: config.heartbeat,
            on_error: config.on_error,
        });
        let inner = Arc::new(Inner {
            api,
            server: config.server,
            assistant: config.assistant,
            backoff: config.backoff,
            connection,
            cache,
            held: Mutex::new(HashMap::new()),
            posting: Mutex::new(HashSet::new()),
        });
        tokio::spawn(deliver_waiting(
            Arc::downgrade(&inner),
            inner.connection.statuses(),
        ));
        Ok(NudgeClient { inner })
    }

    pub fn api(&self) -> &Api {
        &self.inner.api
    }

    pub fn connection(&self) -> &Connection {
        &self.inner.connection
    }

    /// Connects the socket; views held now or later are subscribed once it is open.
    pub fn open(&self) {
        self.inner.connection.open();
    }

    /// Closes the socket; leases stay, and are subscribed again by `open()`.
    pub fn close(&self) {
        self.inner.connection.close();
    }

    /// A room's socket to an extension's panel, such as `lists` or `documents`.
    pub fn panel(
        &self,
        room: &str,
        extension: &str,
        listener: Arc<dyn PanelListener>,
    ) -> Result<PanelSocket, ApiError> {
        let inner = &self.inner;
        let url = panel_url(&inner.server, &inner.assistant, room, extension)?;
        Ok(PanelSocket::open(
            url,
            inner.api.tokens().clone(),
            listener,
            inner.backoff,
        ))
    }

    /// The player's home view.
    pub fn home(&self) -> Lease<HomeStore> {
        let store = self.hold(Target::Home, || {
            Store::Home(Arc::new(HomeStore::new(self.inner.cache.clone())))
        });
        let Store::Home(store) = store else {
            unreachable!("home holds a home store")
        };
        self.lease(Target::Home, store)
    }

    /// A room's view, with its earlier items and this client's pending messages.
    pub fn room(&self, id: &str) -> Lease<RoomStore> {
        let target = Target::Room(id.to_owned());
        let store = self.hold(target.clone(), || {
            let api = self.inner.api.clone();
            let room = id.to_owned();
            let pages: PageLoader = Arc::new(move |page| {
                let api = api.clone();
                let room = room.clone();
                Box::pin(async move { api.timeline(&room, &page).await })
            });
            let store = RoomStore::new(id, self.inner.cache.clone(), Some(pages));
            for message in self.inner.cache.outbox(Some(id)) {
                store.sending(pending(&message));
            }
            Store::Room(Arc::new(store))
        });
        let Store::Room(store) = store else {
            unreachable!("rooms hold room stores")
        };
        self.lease(target, store)
    }

    /// Posts a message, shown as pending in the room's store until the view has it. When it
    /// doesn't get through it stays in the outbox (`Sent::Queued`); when the server refuses it,
    /// the pending message keeps the error and this fails. `resend` tries again with the same
    /// request id, which the server answers with the same submission.
    pub async fn send(
        &self,
        room: &str,
        text: &str,
        options: SendOptions,
    ) -> Result<Sent, ApiError> {
        let message = Outgoing {
            request_id: options.request_id.unwrap_or_else(new_request_id),
            room: room.to_owned(),
            text: text.to_owned(),
            when_busy: options.when_busy,
            private: options.private,
            created_at: now_ms(),
            error: None,
        };
        self.inner.cache.add_outgoing(&message);
        if let Some(store) = self.inner.room_store(room) {
            store.sending(pending(&message));
        }
        self.inner.post(message).await
    }

    /// Sends a message of `room`'s outbox again, such as one the server refused.
    pub async fn resend(&self, room: &str, request_id: &str) -> Result<Sent, ApiError> {
        let message = self
            .inner
            .cache
            .outbox(Some(room))
            .into_iter()
            .find(|m| m.request_id == request_id);
        let message = match message {
            Some(message) => message,
            // Sent already, but not in the view yet.
            None => match self
                .inner
                .room_store(room)
                .and_then(|store| store.pending(request_id))
            {
                Some(pending) => Outgoing {
                    request_id: pending.request_id,
                    room: room.to_owned(),
                    text: pending.text,
                    when_busy: pending.when_busy,
                    private: pending.private,
                    created_at: now_ms(),
                    error: None,
                },
                None => {
                    return Err(ApiError::Status {
                        status: 404,
                        message: format!("No pending message \"{request_id}\""),
                    });
                }
            },
        };
        let message = Outgoing {
            error: None,
            ..message
        };
        self.inner.cache.add_outgoing(&message);
        if let Some(store) = self.inner.room_store(room) {
            store.sending(pending(&message));
        }
        self.inner.post(message).await
    }

    /// Drops a pending message: it leaves the outbox, and the room's store stops showing it.
    pub fn dismiss(&self, room: &str, request_id: &str) {
        self.inner.cache.remove_outgoing(request_id);
        if let Some(store) = self.inner.room_store(room) {
            store.dismiss(request_id);
        }
    }

    /// Sends what waits in the outbox now, rather than on the next reconnect or retry.
    pub async fn deliver_waiting(&self) {
        self.inner.deliver_waiting().await;
    }

    fn hold(&self, target: Target, make: impl FnOnce() -> Store) -> Store {
        let mut held = self.inner.held.lock().unwrap();
        if let Some(entry) = held.get_mut(&target) {
            entry.leases += 1;
            return entry.store.clone();
        }
        let store = make();
        let subscriber: Arc<dyn crate::connection::Subscriber> = match &store {
            Store::Home(store) => store.clone(),
            Store::Room(store) => store.clone(),
        };
        let watch = self
            .inner
            .connection
            .watch(target.clone(), subscriber)
            .expect("the client watches each target once");
        held.insert(
            target,
            Held {
                store: store.clone(),
                leases: 1,
                _watch: watch,
            },
        );
        store
    }

    fn lease<S>(&self, target: Target, store: Arc<S>) -> Lease<S> {
        Lease {
            store,
            target,
            client: Arc::downgrade(&self.inner),
        }
    }
}

impl Inner {
    fn room_store(&self, room: &str) -> Option<Arc<RoomStore>> {
        match self
            .held
            .lock()
            .unwrap()
            .get(&Target::Room(room.to_owned()))?
            .store
            .clone()
        {
            Store::Room(store) => Some(store),
            Store::Home(_) => None,
        }
    }

    async fn post(&self, message: Outgoing) -> Result<Sent, ApiError> {
        if !self
            .posting
            .lock()
            .unwrap()
            .insert(message.request_id.clone())
        {
            return Ok(Sent::Queued);
        }
        let body = MessageRequest {
            text: message.text.clone(),
            request_id: message.request_id.clone(),
            when_busy: message.when_busy,
            private: message.private.then_some(true),
        };
        let result = self.api.send(&message.room, &body).await;
        self.posting.lock().unwrap().remove(&message.request_id);
        let store = self.room_store(&message.room);
        match result {
            Ok(response) => {
                self.cache.remove_outgoing(&message.request_id);
                Ok(Sent::Delivered(response))
            }
            Err(error) if error.is_retryable() => {
                if let Some(store) = store {
                    store.set_pending(
                        &message.request_id,
                        PendingState::Waiting {
                            error: error.to_string(),
                        },
                    );
                }
                Ok(Sent::Queued)
            }
            Err(error) => {
                self.cache
                    .set_outgoing_error(&message.request_id, Some(&error.to_string()));
                if let Some(store) = store {
                    store.set_pending(
                        &message.request_id,
                        PendingState::Failed {
                            error: error.to_string(),
                        },
                    );
                }
                Err(error)
            }
        }
    }

    async fn deliver_waiting(&self) {
        for message in self.cache.outbox(None) {
            if message.error.is_none() {
                let _ = self.post(message).await;
            }
        }
    }
}

/// Sends the outbox whenever the socket opens, and every `RETRY_EVERY` while it is open. On a
/// welcome for another player than the cache's, the cache starts over first.
async fn deliver_waiting(
    client: Weak<Inner>,
    mut statuses: tokio::sync::watch::Receiver<ConnectionStatus>,
) {
    let mut retry = tokio::time::interval(RETRY_EVERY);
    retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            changed = statuses.changed() => if changed.is_err() { return },
            _ = retry.tick() => {},
        }
        let welcome = match &*statuses.borrow_and_update() {
            ConnectionStatus::Open { welcome } => welcome.clone(),
            _ => continue,
        };
        let Some(inner) = client.upgrade() else {
            return;
        };
        inner.cache.claim(&welcome.player.id);
        inner.deliver_waiting().await;
    }
}

fn pending(message: &Outgoing) -> PendingMessage {
    PendingMessage {
        request_id: message.request_id.clone(),
        text: message.text.clone(),
        when_busy: message.when_busy,
        private: message.private,
        state: match &message.error {
            Some(error) => PendingState::Failed {
                error: error.clone(),
            },
            None => PendingState::Sending,
        },
    }
}

/// A random id: 16 random bytes as hex.
pub fn new_request_id() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}
