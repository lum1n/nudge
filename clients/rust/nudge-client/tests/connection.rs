//! `Connection` against a fake server in the test: signing in, subscribing, gaps, backoff,
//! giving up, and pings on a quiet socket.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nudge_client::protocol::*;
use nudge_client::*;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

type Socket = WebSocketStream<TcpStream>;

/// A server that hands the test every socket a client opens.
struct FakeServer {
    url: String,
    sockets: mpsc::UnboundedReceiver<Socket>,
}

impl FakeServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/a/robin/connect", listener.local_addr().unwrap());
        let (sender, sockets) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                if let Ok(socket) = tokio_tungstenite::accept_async(stream).await {
                    let _ = sender.send(socket);
                }
            }
        });
        FakeServer { url, sockets }
    }

    async fn accept(&mut self) -> Socket {
        timeout(Duration::from_secs(5), self.sockets.recv())
            .await
            .expect("a socket in time")
            .unwrap()
    }

    async fn no_socket_for(&mut self, wait: Duration) {
        assert!(
            timeout(wait, self.sockets.recv()).await.is_err(),
            "no new socket"
        );
    }
}

async fn read(socket: &mut Socket) -> Value {
    loop {
        let message = timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("a frame in time");
        if let Some(Ok(Message::Text(text))) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn write(socket: &mut Socket, frame: Value) {
    socket.send(Message::text(frame.to_string())).await.unwrap();
}

async fn close(socket: &mut Socket, code: u16) {
    let frame = CloseFrame {
        code: code.into(),
        reason: "".into(),
    };
    let _ = socket.close(Some(frame)).await;
}

fn welcome(heartbeat_ms: u64) -> Value {
    json!({
        "type": "welcome", "protocol": 1, "server": { "version": "1" }, "epoch": "e1",
        "player": { "id": "ann", "displayName": "Ann" }, "clientId": "client-1", "heartbeatMs": heartbeat_ms,
    })
}

fn room_list_view() -> Value {
    json!({ "player": { "id": "ann", "displayName": "Ann" }, "rooms": [], "nudges": [] })
}

fn connection(url: &str, token: Option<&str>) -> Connection {
    Connection::new(ConnectionOptions {
        url: url.to_owned(),
        tokens: Arc::new(MemoryTokens::new(token.map(str::to_owned))),
        client: ClientDescription {
            name: "test".into(),
            version: "1".into(),
            platform: "rust".into(),
        },
        backoff: Backoff {
            start: Duration::from_millis(10),
            max: Duration::from_millis(50),
        },
        heartbeat: Duration::from_secs(5),
        on_error: None,
    })
}

async fn until<T: Clone>(states: &mut watch::Receiver<T>, check: impl Fn(&T) -> bool) -> T {
    let state = timeout(
        Duration::from_secs(5),
        states.wait_for(|state| check(state)),
    )
    .await;
    state.expect("the state in time").unwrap().clone()
}

#[tokio::test]
async fn signs_in_subscribes_and_subscribes_again_after_a_gap() {
    let mut server = FakeServer::start().await;
    let connection = connection(&server.url, Some("secret"));
    let store = Arc::new(RoomListStore::new(Arc::new(Cache::in_memory())));
    let _watch = connection.watch(Target::RoomList, store.clone()).unwrap();
    assert_eq!(
        connection.watch(Target::RoomList, store.clone()).err(),
        Some(AlreadyWatched(Target::RoomList))
    );
    connection.open();

    let mut socket = server.accept().await;
    let hello = read(&mut socket).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["token"], "secret");
    assert_eq!(
        hello["client"],
        json!({ "name": "test", "version": "1", "platform": "rust" })
    );
    write(&mut socket, welcome(25_000)).await;
    assert_eq!(
        read(&mut socket).await,
        json!({ "type": "subscribe", "target": "rooms" })
    );
    let mut statuses = connection.statuses();
    until(
        &mut statuses,
        |s| matches!(s, ConnectionStatus::Open { welcome } if welcome.client_id == "client-1"),
    )
    .await;

    write(
        &mut socket,
        json!({ "type": "snapshot", "target": "rooms", "seq": 0, "view": room_list_view() }),
    )
    .await;
    let mut states = store.states();
    until(&mut states, |s| s.status == SyncStatus::Live).await;
    // A patch with seq 2 after 0: the store asks for a new snapshot.
    let ops = json!([{ "op": "set", "path": ["nudges"], "value": [] }]);
    write(
        &mut socket,
        json!({ "type": "patch", "target": "rooms", "seq": 2, "ops": ops }),
    )
    .await;
    assert_eq!(
        read(&mut socket).await,
        json!({ "type": "subscribe", "target": "rooms" })
    );
    assert_eq!(store.state().status, SyncStatus::Syncing);

    // Watching a room subscribes it at once; letting it go unsubscribes.
    let room = Arc::new(RoomStore::new("trip", Arc::new(Cache::in_memory()), None));
    let watch = connection.watch(Target::Room("trip".into()), room).unwrap();
    assert_eq!(
        read(&mut socket).await,
        json!({ "type": "subscribe", "target": "room:trip" })
    );
    drop(watch);
    assert_eq!(
        read(&mut socket).await,
        json!({ "type": "unsubscribe", "target": "room:trip" })
    );
}

#[tokio::test]
async fn reconnects_with_backoff_and_gives_up_on_an_unknown_token() {
    let mut server = FakeServer::start().await;
    let connection = connection(&server.url, Some("secret"));
    let store = Arc::new(RoomListStore::new(Arc::new(Cache::in_memory())));
    let _watch = connection.watch(Target::RoomList, store.clone()).unwrap();
    let mut statuses = connection.statuses();
    connection.open();

    let mut socket = server.accept().await;
    read(&mut socket).await;
    write(&mut socket, welcome(25_000)).await;
    read(&mut socket).await;
    write(
        &mut socket,
        json!({ "type": "snapshot", "target": "rooms", "seq": 0, "view": room_list_view() }),
    )
    .await;
    let mut states = store.states();
    until(&mut states, |s| s.status == SyncStatus::Live).await;

    close(&mut socket, 1011).await;
    let waiting = until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Waiting { .. })
    })
    .await;
    assert!(
        matches!(
            waiting,
            ConnectionStatus::Waiting {
                attempt: 1,
                code: 1011,
                ..
            }
        ),
        "{waiting:?}"
    );
    // The store keeps its view while it waits for a new snapshot.
    let state = store.state();
    assert_eq!(state.status, SyncStatus::Syncing);
    assert!(state.view.is_some());

    let mut socket = server.accept().await;
    read(&mut socket).await;
    write(&mut socket, welcome(25_000)).await;
    // Subscribed again after the welcome.
    assert_eq!(
        read(&mut socket).await,
        json!({ "type": "subscribe", "target": "rooms" })
    );
    until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Open { .. })
    })
    .await;

    close(&mut socket, close::UNAUTHORIZED).await;
    let closed = until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Closed { .. })
    })
    .await;
    assert!(
        matches!(closed, ConnectionStatus::Closed { code: 4401, .. }),
        "{closed:?}"
    );
    server.no_socket_for(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn pings_a_quiet_server_and_drops_a_dead_socket() {
    let mut server = FakeServer::start().await;
    let connection = connection(&server.url, Some("secret"));
    let mut statuses = connection.statuses();
    connection.open();

    let mut socket = server.accept().await;
    read(&mut socket).await;
    write(&mut socket, welcome(100)).await;
    assert_eq!(read(&mut socket).await, json!({ "type": "ping" }));
    write(&mut socket, json!({ "type": "pong" })).await;
    // Answered: another ping after another quiet spell, then no answer.
    assert_eq!(read(&mut socket).await, json!({ "type": "ping" }));
    let waiting = until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Waiting { .. })
    })
    .await;
    assert!(
        matches!(waiting, ConnectionStatus::Waiting { code: QUIET, .. }),
        "{waiting:?}"
    );
    server.accept().await;
}

#[tokio::test]
async fn needs_a_token_and_a_server_address() {
    let mut server = FakeServer::start().await;
    let connection = connection(&server.url, None);
    let mut statuses = connection.statuses();
    connection.open();
    let closed = until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Closed { code: 4401, .. })
    })
    .await;
    assert!(matches!(closed, ConnectionStatus::Closed { reason, .. } if reason == "No token"));
    server.no_socket_for(Duration::from_millis(100)).await;

    assert_eq!(
        connect_url("https://example.com/nudge", "robin").unwrap(),
        "wss://example.com/nudge/v1/a/robin/connect"
    );
    assert_eq!(
        connect_url("http://127.0.0.1:8787/", "a b").unwrap(),
        "ws://127.0.0.1:8787/v1/a/a%20b/connect"
    );
    assert!(connect_url("ftp://example.com", "robin").is_err());
}

#[tokio::test]
async fn closing_drops_the_socket_and_stays_closed() {
    let mut server = FakeServer::start().await;
    let connection = connection(&server.url, Some("secret"));
    let mut statuses = connection.statuses();
    connection.open();
    let mut socket = server.accept().await;
    read(&mut socket).await;
    write(&mut socket, welcome(25_000)).await;
    until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Open { .. })
    })
    .await;
    connection.close();
    until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Closed { code: 1000, .. })
    })
    .await;
    // The server sees the socket close.
    let ended = timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok());
    server.no_socket_for(Duration::from_millis(100)).await;
    // Opening again connects again.
    connection.open();
    server.accept().await;
}

/// Hears a panel socket's statuses and frames.
struct PanelEvents(mpsc::UnboundedSender<Result<Value, PanelStatus>>);

impl PanelListener for PanelEvents {
    fn status(&self, status: PanelStatus) {
        let _ = self.0.send(Err(status));
    }

    fn frame(&self, frame: Value) {
        let _ = self.0.send(Ok(frame));
    }
}

async fn next_event(
    events: &mut mpsc::UnboundedReceiver<Result<Value, PanelStatus>>,
) -> Result<Value, PanelStatus> {
    timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("an event in time")
        .unwrap()
}

#[tokio::test]
async fn panel_socket_says_hello_relays_frames_reconnects_and_gives_up() {
    let mut server = FakeServer::start().await;
    let url = server
        .url
        .replace("/connect", "/rooms/trip/ext/lists")
        .parse()
        .unwrap();
    assert_eq!(
        panel_url("https://nudge.example/x/", "robin", "a b", "lists")
            .unwrap()
            .as_str(),
        "wss://nudge.example/x/v1/a/robin/rooms/a%20b/ext/lists"
    );
    let (sender, mut events) = mpsc::unbounded_channel();
    let panel = PanelSocket::open(
        url,
        Arc::new(MemoryTokens::new(Some("t1".into()))),
        Arc::new(PanelEvents(sender)),
        Backoff {
            start: Duration::from_millis(20),
            max: Duration::from_millis(40),
        },
    );
    assert_eq!(next_event(&mut events).await, Err(PanelStatus::Connecting));
    let mut socket = server.accept().await;
    assert_eq!(
        read(&mut socket).await,
        json!({ "type": "hello", "token": "t1" })
    );
    write(&mut socket, json!({ "type": "ready" })).await;
    assert_eq!(next_event(&mut events).await, Err(PanelStatus::Open));
    let lists = json!({ "type": "lists", "lists": [] });
    write(&mut socket, lists.clone()).await;
    assert_eq!(next_event(&mut events).await, Ok(lists));
    panel.send(&json!({ "type": "add", "list": "Shopping", "text": "Milk" }));
    assert_eq!(read(&mut socket).await["text"], "Milk");

    // Dropped: back with a new hello.
    close(&mut socket, 1011).await;
    assert_eq!(next_event(&mut events).await, Err(PanelStatus::Connecting));
    let mut socket = server.accept().await;
    assert_eq!(read(&mut socket).await["type"], "hello");
    // A bad token: no more tries.
    close(&mut socket, 4401).await;
    assert_eq!(
        next_event(&mut events).await,
        Err(PanelStatus::Closed {
            code: 4401,
            reason: String::new()
        })
    );
    server.no_socket_for(Duration::from_millis(200)).await;
}
