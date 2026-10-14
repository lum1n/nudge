use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures_util::{SinkExt, StreamExt};
use nudge_protocol::*;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

use crate::api::{ApiError, TokenStore, endpoint};

#[derive(Clone, Debug, PartialEq)]
pub enum ConnectionStatus {
    /// Opening a socket, or waiting for the welcome.
    Connecting {
        attempt: u32,
    },
    Open {
        welcome: Welcome,
    },
    /// Lost, and trying again at `retry_at`.
    Waiting {
        attempt: u32,
        retry_at: SystemTime,
        code: u16,
    },
    /// Given up: `close()` was called (code 1000), the token is missing, unknown or revoked
    /// (4401), the server didn't take a frame (4400), or there is no such assistant (4404).
    Closed {
        code: u16,
        reason: String,
    },
}

/// The frames that belong to one target.
#[derive(Clone, Debug, PartialEq)]
pub enum TargetFrame {
    Snapshot { seq: u64, view: Value },
    Patch { seq: u64, ops: Vec<Op> },
    Unsubscribed { reason: UnsubscribedReason },
}

/// What a `Connection` hands a target's frames to.
pub trait Subscriber: Send + Sync {
    /// Takes the next frame for the target. False when it doesn't follow on from the last one (a
    /// gap in `seq`, or ops that don't fit the view): the connection then subscribes again.
    fn receive(&self, frame: TargetFrame) -> bool;
    /// The socket dropped, or the target is being subscribed again: wait for a new snapshot.
    fn resync(&self);
}

/// Delay before the first retry, doubled on each one after it, up to `max`; with jitter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    pub start: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            start: Duration::from_secs(1),
            max: Duration::from_secs(30),
        }
    }
}

/// Hears `error` frames.
pub type OnError = Arc<dyn Fn(&str) + Send + Sync>;

pub struct ConnectionOptions {
    /// `ws(s)://…/v1/a/<assistant>/connect`; see `connect_url`.
    pub url: String,
    /// Read on every attempt, so a new token is picked up on the next one.
    pub tokens: Arc<dyn TokenStore>,
    pub client: ClientDescription,
    pub backoff: Backoff,
    /// How long to wait for any frame before a ping, until the welcome says otherwise.
    pub heartbeat: Duration,
    /// `error` frames: the server couldn't use a frame, the socket stays open.
    pub on_error: Option<OnError>,
}

/// Close codes not worth retrying: the server will say the same again.
const GIVE_UP: [u16; 3] = [close::BAD_REQUEST, close::UNAUTHORIZED, close::NOT_FOUND];
/// Our own code for a socket we dropped because it went quiet.
pub const QUIET: u16 = 4000;
/// A socket that closed without saying why.
const ABNORMAL: u16 = 1006;

/// The socket address for `assistant` on `server`, such as `https://nudge.example`.
pub fn connect_url(server: &str, assistant: &str) -> Result<String, ApiError> {
    let invalid = || ApiError::Address(server.to_owned());
    let base = Url::parse(server).map_err(|_| invalid())?;
    let mut url = endpoint(&base, &["v1", "a", assistant, "connect"]);
    let scheme = match base.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err(invalid()),
    };
    url.set_scheme(scheme).map_err(|_| invalid())?;
    Ok(url.into())
}

/// One socket to an assistant, kept open by a task of its own: it signs in, subscribes every
/// watched target, hands each target's frames to its subscriber, pings when the server goes quiet,
/// and reconnects with backoff when the socket drops, subscribing again (the server keeps no state
/// between sockets). A target whose frames stop following on is subscribed again.
///
/// The task ends when every handle (and every `Watch`) is dropped. Make one inside a Tokio runtime.
#[derive(Clone)]
pub struct Connection {
    commands: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
}

struct Shared {
    status: watch::Sender<ConnectionStatus>,
    watched: Mutex<BTreeMap<Target, Watched>>,
    next_id: AtomicU64,
}

#[derive(Clone)]
struct Watched {
    id: u64,
    subscriber: Arc<dyn Subscriber>,
}

enum Command {
    Open,
    Close,
    RetryNow,
    Subscribe(Target),
    Unsubscribe(Target),
}

/// A target being watched; dropping it unsubscribes.
pub struct Watch {
    target: Target,
    id: u64,
    commands: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
}

impl Drop for Watch {
    fn drop(&mut self) {
        let mut watched = self.shared.watched.lock().unwrap();
        if watched.get(&self.target).is_some_and(|w| w.id == self.id) {
            watched.remove(&self.target);
            let _ = self
                .commands
                .send(Command::Unsubscribe(self.target.clone()));
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0} is watched already")]
pub struct AlreadyWatched(pub Target);

impl Connection {
    pub fn new(options: ConnectionOptions) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        let closed = ConnectionStatus::Closed {
            code: 1000,
            reason: "Not opened".into(),
        };
        let shared = Arc::new(Shared {
            status: watch::Sender::new(closed),
            watched: Mutex::new(BTreeMap::new()),
            next_id: AtomicU64::new(0),
        });
        let heartbeat = options.heartbeat;
        let actor = Actor {
            options,
            shared: shared.clone(),
            commands: receiver,
            socket: None,
            connecting: None,
            attempt: 0,
            retry_at: None,
            quiet: None,
            heartbeat,
        };
        tokio::spawn(actor.run());
        Connection { commands, shared }
    }

    pub fn status(&self) -> ConnectionStatus {
        self.shared.status.borrow().clone()
    }

    /// Hears of every status change.
    pub fn statuses(&self) -> watch::Receiver<ConnectionStatus> {
        self.shared.status.subscribe()
    }

    /// Starts connecting, unless already connected or connecting.
    pub fn open(&self) {
        let _ = self.commands.send(Command::Open);
    }

    /// Reconnects at once when waiting to retry, such as when the network comes back.
    pub fn retry_now(&self) {
        let _ = self.commands.send(Command::RetryNow);
    }

    pub fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }

    /// Subscribes `target` now and after every reconnect, until the `Watch` is dropped.
    pub fn watch(
        &self,
        target: Target,
        subscriber: Arc<dyn Subscriber>,
    ) -> Result<Watch, AlreadyWatched> {
        let mut watched = self.shared.watched.lock().unwrap();
        if watched.contains_key(&target) {
            return Err(AlreadyWatched(target));
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        watched.insert(target.clone(), Watched { id, subscriber });
        let _ = self.commands.send(Command::Subscribe(target.clone()));
        Ok(Watch {
            target,
            id,
            commands: self.commands.clone(),
            shared: self.shared.clone(),
        })
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Connecting = Pin<Box<dyn Future<Output = Result<Socket, String>> + Send>>;

struct Actor {
    options: ConnectionOptions,
    shared: Arc<Shared>,
    commands: mpsc::UnboundedReceiver<Command>,
    socket: Option<Socket>,
    connecting: Option<Connecting>,
    attempt: u32,
    retry_at: Option<Instant>,
    /// When to ping, or, once pinged, to give the socket up.
    quiet: Option<(Instant, bool)>,
    heartbeat: Duration,
}

impl Actor {
    async fn run(mut self) {
        loop {
            tokio::select! {
                command = self.commands.recv() => match command {
                    Some(command) => self.command(command).await,
                    None => {
                        self.drop_socket();
                        return;
                    }
                },
                result = async { self.connecting.as_mut().unwrap().await }, if self.connecting.is_some() => {
                    self.connecting = None;
                    match result {
                        Ok(socket) => self.opened(socket).await,
                        Err(reason) => self.lost(ABNORMAL, reason),
                    }
                },
                message = async { self.socket.as_mut().unwrap().next().await }, if self.socket.is_some() => {
                    self.message(message).await;
                },
                _ = sleep_until(self.retry_at) => {
                    self.retry_at = None;
                    self.connect();
                },
                _ = sleep_until(self.quiet.map(|(at, _)| at)) => self.quiet().await,
            }
        }
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Open => {
                if matches!(
                    self.status(),
                    ConnectionStatus::Connecting { .. } | ConnectionStatus::Open { .. }
                ) {
                    return;
                }
                self.retry_at = None;
                self.attempt = 0;
                self.connect();
            }
            Command::RetryNow => {
                if matches!(self.status(), ConnectionStatus::Waiting { .. }) {
                    self.retry_at = None;
                    self.connect();
                }
            }
            Command::Close => {
                self.retry_at = None;
                self.drop_socket();
                self.resync_all();
                self.set_status(ConnectionStatus::Closed {
                    code: 1000,
                    reason: "Closed".into(),
                });
            }
            Command::Subscribe(target) => {
                if self.is_open() {
                    self.send(&ClientFrame::Subscribe { target }).await;
                }
            }
            Command::Unsubscribe(target) => {
                // Watched again since: the subscription stays.
                if self.is_open() && !self.shared.watched.lock().unwrap().contains_key(&target) {
                    self.send(&ClientFrame::Unsubscribe { target }).await;
                }
            }
        }
    }

    fn connect(&mut self) {
        let Some(token) = self.options.tokens.get() else {
            self.set_status(ConnectionStatus::Closed {
                code: close::UNAUTHORIZED,
                reason: "No token".into(),
            });
            return;
        };
        self.set_status(ConnectionStatus::Connecting {
            attempt: self.attempt,
        });
        let url = self.options.url.clone();
        let hello = ClientFrame::Hello {
            protocol: PROTOCOL_VERSION,
            token,
            client: self.options.client.clone(),
        };
        let timeout = self.heartbeat;
        self.connecting = Some(Box::pin(async move {
            let opening = tokio_tungstenite::connect_async(url);
            let (mut socket, _) = match tokio::time::timeout(timeout, opening).await {
                Ok(Ok(opened)) => opened,
                Ok(Err(error)) => return Err(error.to_string()),
                Err(_) => return Err("Timed out connecting".into()),
            };
            let hello = serde_json::to_string(&hello).expect("frames serialize");
            socket
                .send(Message::text(hello))
                .await
                .map_err(|error| error.to_string())?;
            Ok(socket)
        }));
    }

    async fn opened(&mut self, socket: Socket) {
        self.socket = Some(socket);
        self.listen();
    }

    async fn message(
        &mut self,
        message: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
    ) {
        match message {
            Some(Ok(Message::Text(text))) => {
                self.listen();
                // Frames this client can't read are left alone, as in the TypeScript client.
                if let Ok(frame) = serde_json::from_str::<ServerFrame>(&text) {
                    self.receive(frame).await;
                }
            }
            Some(Ok(Message::Close(frame))) => {
                let (code, reason) = match frame {
                    Some(frame) => (u16::from(frame.code), frame.reason.to_string()),
                    None => (ABNORMAL, String::new()),
                };
                self.lost(code, reason);
            }
            Some(Ok(_)) => self.listen(),
            Some(Err(error)) => self.lost(ABNORMAL, error.to_string()),
            None => self.lost(ABNORMAL, "Socket ended".into()),
        }
    }

    async fn receive(&mut self, frame: ServerFrame) {
        let (target, frame) = match frame {
            ServerFrame::Welcome(welcome) => {
                self.attempt = 0;
                self.heartbeat = Duration::from_millis(welcome.heartbeat_ms);
                self.listen();
                self.set_status(ConnectionStatus::Open { welcome });
                let watched: Vec<(Target, Watched)> = self
                    .shared
                    .watched
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(t, w)| (t.clone(), w.clone()))
                    .collect();
                for (target, watched) in watched {
                    watched.subscriber.resync();
                    self.send(&ClientFrame::Subscribe { target }).await;
                }
                return;
            }
            ServerFrame::Snapshot { target, seq, view } => {
                (target, TargetFrame::Snapshot { seq, view })
            }
            ServerFrame::Patch { target, seq, ops } => (target, TargetFrame::Patch { seq, ops }),
            ServerFrame::Unsubscribed { target, reason } => {
                (target, TargetFrame::Unsubscribed { reason })
            }
            ServerFrame::Error { message } => {
                if let Some(on_error) = &self.options.on_error {
                    on_error(&message);
                }
                return;
            }
            ServerFrame::Pong | ServerFrame::Unknown => return,
        };
        let subscriber = self
            .shared
            .watched
            .lock()
            .unwrap()
            .get(&target)
            .map(|w| w.subscriber.clone());
        if let Some(subscriber) = subscriber
            && !subscriber.receive(frame)
        {
            self.send(&ClientFrame::Subscribe { target }).await;
        }
    }

    /// After `heartbeat` without a frame, ping; after as long again, give the socket up as dead,
    /// since a lost network may not close it for minutes.
    async fn quiet(&mut self) {
        match self.quiet {
            Some((_, false)) => {
                self.quiet = Some((Instant::now() + self.heartbeat, true));
                self.send(&ClientFrame::Ping).await;
            }
            _ => {
                self.drop_socket();
                self.lost(QUIET, "No answer to a ping".into());
            }
        }
    }

    /// Restarts the quiet timer.
    fn listen(&mut self) {
        self.quiet = Some((Instant::now() + self.heartbeat, false));
    }

    fn lost(&mut self, code: u16, reason: String) {
        self.socket = None;
        self.connecting = None;
        self.quiet = None;
        self.resync_all();
        if GIVE_UP.contains(&code) {
            self.set_status(ConnectionStatus::Closed { code, reason });
            return;
        }
        let Backoff { start, max } = self.options.backoff;
        let full = start
            .saturating_mul(2u32.saturating_pow(self.attempt))
            .min(max);
        // Half fixed, half random, so clients cut off together don't come back together.
        let delay = full.mul_f64(0.5 + rand::random::<f64>() / 2.0);
        self.attempt += 1;
        self.retry_at = Some(Instant::now() + delay);
        self.set_status(ConnectionStatus::Waiting {
            attempt: self.attempt,
            retry_at: SystemTime::now() + delay,
            code,
        });
    }

    /// Closes the socket without hearing about it.
    fn drop_socket(&mut self) {
        self.quiet = None;
        self.connecting = None;
        if let Some(mut socket) = self.socket.take() {
            tokio::spawn(async move {
                let _ = socket.close(None).await;
            });
        }
    }

    fn resync_all(&self) {
        let subscribers: Vec<Arc<dyn Subscriber>> = self
            .shared
            .watched
            .lock()
            .unwrap()
            .values()
            .map(|w| w.subscriber.clone())
            .collect();
        for subscriber in subscribers {
            subscriber.resync();
        }
    }

    async fn send(&mut self, frame: &ClientFrame) {
        if let Some(socket) = &mut self.socket {
            let text = serde_json::to_string(frame).expect("frames serialize");
            // Not open any more: the close, or the quiet timer, sorts it out.
            let _ = socket.send(Message::text(text)).await;
        }
    }

    fn is_open(&self) -> bool {
        matches!(self.status(), ConnectionStatus::Open { .. })
    }

    fn status(&self) -> ConnectionStatus {
        self.shared.status.borrow().clone()
    }

    fn set_status(&self, status: ConnectionStatus) {
        self.shared.status.send_replace(status);
    }
}

/// Sleeps until `at`; forever without one.
async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}
