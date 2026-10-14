//! `NudgeClient` against a real Nudge server on a faux model
//! (`packages/server/scripts/faux-server.ts`, which runs the built packages: `pnpm build` first).
//! Skipped, saying so, when `node` or the build is missing.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use nudge_client::protocol::*;
use nudge_client::*;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio::time::timeout;

struct FauxServer {
    url: String,
    ann: String,
    _process: Child,
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

async fn faux_server() -> Option<FauxServer> {
    if !root().join("packages/server/dist/index.js").exists() {
        eprintln!("skipped: no packages/server/dist; run `pnpm build` first");
        return None;
    }
    let spawned = Command::new("node")
        .arg(root().join("packages/server/scripts/faux-server.ts"))
        .current_dir(root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut process) = spawned else {
        eprintln!("skipped: no node");
        return None;
    };
    let mut lines = BufReader::new(process.stdout.take().unwrap()).lines();
    let line = timeout(Duration::from_secs(30), lines.next_line())
        .await
        .expect("the server starts")
        .unwrap();
    let started: Value =
        serde_json::from_str(&line.expect("the server prints its address")).unwrap();
    Some(FauxServer {
        url: started["url"].as_str().unwrap().to_owned(),
        ann: started["tokens"]["ann"].as_str().unwrap().to_owned(),
        _process: process,
    })
}

fn config(server: &str, cache: Option<PathBuf>) -> ClientConfig {
    let description = ClientDescription {
        name: "test".into(),
        version: "1".into(),
        platform: "rust".into(),
    };
    ClientConfig {
        cache,
        backoff: Backoff {
            start: Duration::from_millis(10),
            max: Duration::from_millis(50),
        },
        ..ClientConfig::new(server, "robin", description)
    }
}

fn client(server: &str, token: Option<&str>) -> NudgeClient {
    NudgeClient::new(config(server, None), tokens(token)).unwrap()
}

fn tokens(token: Option<&str>) -> Arc<dyn TokenStore> {
    Arc::new(MemoryTokens::new(token.map(str::to_owned)))
}

fn client_info() -> ClientInfo {
    ClientInfo {
        name: "test".into(),
        platform: "rust".into(),
    }
}

async fn until<T: Clone>(states: &mut watch::Receiver<T>, check: impl Fn(&T) -> bool) -> T {
    let state = timeout(
        Duration::from_secs(20),
        states.wait_for(|state| check(state)),
    )
    .await;
    state.expect("the state in time").unwrap().clone()
}

fn user_texts(state: &RoomState) -> Vec<String> {
    state
        .timeline
        .iter()
        .filter_map(|item| match item {
            TimelineItem::User(user) => Some(user.text.clone()),
            _ => None,
        })
        .collect()
}

/// Whether the room is idle with every answer done.
fn settled(state: &RoomState) -> bool {
    let Some(view) = &state.view else {
        return false;
    };
    !view.live.running
        && view.queue.is_empty()
        && matches!(view.timeline.last(), Some(TimelineItem::Answer(answer)) if answer.status == AnswerStatus::Done)
}

fn temp_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nudge-client-{}", rand_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn rand_suffix() -> String {
    new_request_id()[..12].to_owned()
}

#[tokio::test]
async fn pairs_follows_home_and_a_room_and_swaps_a_pending_message_for_the_real_one() {
    let Some(server) = faux_server().await else {
        return;
    };
    let assistants = list_assistants(&server.url).await.unwrap();
    assert_eq!(
        assistants
            .assistants
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        ["robin"]
    );
    let admin = Api::new(&server.url, "robin", tokens(Some(&server.ann))).unwrap();
    let code = admin.pairing_code("bo").await.unwrap().code;

    let client = client(&server.url, None);
    assert_eq!(client.api().me().await.unwrap_err().status(), Some(401));
    let paired = client.api().pair(&code, client_info()).await.unwrap();
    assert_eq!(paired.player.id, "bo");
    assert_eq!(
        client
            .api()
            .pair(&code, client_info())
            .await
            .unwrap_err()
            .status(),
        Some(401)
    );
    let me = client.api().me().await.unwrap();
    assert_eq!(
        (me.client_id.as_str(), me.admin),
        (paired.client_id.as_str(), false)
    );

    let home = client.home();
    let room = client.room("trip");
    // A second lease shares the store and the subscription.
    let again = client.room("trip");
    assert!(Arc::ptr_eq(again.store(), room.store()));
    drop(again);
    client.open();
    let mut home_states = home.states();
    let home_state = until(&mut home_states, |s| s.status == SyncStatus::Live).await;
    let rooms: Vec<String> = home_state
        .view
        .as_ref()
        .unwrap()
        .rooms
        .iter()
        .map(|row| row.room.id.clone())
        .collect();
    assert_eq!(rooms, ["lobby", "trip"]);
    let mut states = room.states();
    until(&mut states, |s| s.status == SyncStatus::Live).await;
    match client.connection().status() {
        ConnectionStatus::Open { welcome } => assert_eq!(welcome.client_id, paired.client_id),
        other => panic!("not open: {other:?}"),
    }

    // Streaming text arrives in pieces: collect every state of the answer's text.
    let texts = tokio::spawn({
        let mut states = room.states();
        async move {
            let mut texts = std::collections::BTreeSet::new();
            while states.changed().await.is_ok() {
                let state = states.borrow_and_update().clone();
                for item in state.timeline.iter() {
                    if let TimelineItem::Answer(answer) = item {
                        for part in &answer.parts {
                            if let Part::Text { text } = part {
                                texts.insert(text.clone());
                            }
                        }
                    }
                }
                if settled(&state) {
                    return texts;
                }
            }
            texts
        }
    });
    let sent = client
        .send("trip", "Hello", SendOptions::default())
        .await
        .unwrap();
    assert!(matches!(sent, Sent::Delivered(_)), "{sent:?}");
    let state = until(&mut states, |s| settled(s)).await;
    assert_eq!(user_texts(&state), ["Hello"]);
    assert!(state.pending.is_empty());
    let texts = timeout(Duration::from_secs(20), texts)
        .await
        .unwrap()
        .unwrap();
    assert!(texts.len() > 2, "the answer streamed: {texts:?}");
    assert!(texts.iter().any(|text| text.starts_with("Hello!")));

    // Commands show up in the view.
    client
        .api()
        .remember("trip", "Bo likes trains")
        .await
        .unwrap();
    let state = until(&mut states, |s| {
        s.view.as_ref().is_some_and(|v| v.memory.len() == 1)
    })
    .await;
    let fact = state.view.as_ref().unwrap().memory[0].clone();
    client.api().forget("trip", &fact.id).await.unwrap();
    until(&mut states, |s| {
        s.view.as_ref().is_some_and(|v| v.memory.is_empty())
    })
    .await;

    // A message the server refuses stays failed until dismissed.
    let lobby = client.room("nowhere");
    let refused = client
        .send("nowhere", "Hi?", SendOptions::default())
        .await
        .unwrap_err();
    assert_eq!(refused.status(), Some(404));
    assert!(matches!(
        &lobby.state().pending[..],
        [PendingMessage {
            state: PendingState::Failed { .. },
            ..
        }]
    ));
    let request_id = lobby.state().pending[0].request_id.clone();
    assert_eq!(
        client
            .resend("nowhere", &request_id)
            .await
            .unwrap_err()
            .status(),
        Some(404)
    );
    client.dismiss("nowhere", &request_id);
    assert!(lobby.state().pending.is_empty());
}

#[tokio::test]
async fn loads_earlier_items_back_to_the_start_joining_the_room_view() {
    let Some(server) = faux_server().await else {
        return;
    };
    let client = client(&server.url, Some(&server.ann));
    let room = client.room("trip");
    client.open();
    let mut states = room.states();
    until(&mut states, |s| s.status == SyncStatus::Live).await;
    for n in 0..60 {
        client
            .send("trip", &format!("Message {n}"), SendOptions::default())
            .await
            .unwrap();
        until(&mut states, |s| settled(s) && user_texts(s).len() == n + 1).await;
    }
    let state = room.state();
    assert!(state.can_load_earlier);
    assert!(state.view.as_ref().unwrap().timeline.len() <= 100);
    let mut pages = 0;
    while room.state().can_load_earlier {
        room.load_earlier(Some(7)).await;
        assert_eq!(room.state().earlier_error, None);
        pages += 1;
    }
    assert!(pages > 2);
    let state = room.state();
    let expected: Vec<String> = (0..60).map(|n| format!("Message {n}")).collect();
    assert_eq!(user_texts(&state), expected);
    // Every answer once, after its message.
    let kinds: Vec<&str> = state
        .timeline
        .iter()
        .map(|item| match item {
            TimelineItem::User(_) => "user",
            TimelineItem::Answer(_) => "answer",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["user", "answer"].repeat(60));
    let mut ids: Vec<&str> = state.timeline.iter().filter_map(TimelineItem::id).collect();
    ids.dedup();
    assert_eq!(ids.len(), 120);
}

#[tokio::test]
async fn keeps_the_outbox_and_views_between_runs_and_sends_what_waited() {
    let Some(server) = faux_server().await else {
        return;
    };
    let cache = temp_path("cache.sqlite");
    // Nothing listens on port 9: the message waits.
    let offline = NudgeClient::new(
        config("http://127.0.0.1:9", Some(cache.clone())),
        tokens(Some(&server.ann)),
    )
    .unwrap();
    let room = offline.room("trip");
    let sent = offline
        .send("trip", "Sent while offline", SendOptions::default())
        .await
        .unwrap();
    assert_eq!(sent, Sent::Queued);
    assert!(matches!(
        &room.state().pending[..],
        [PendingMessage {
            state: PendingState::Waiting { .. },
            ..
        }]
    ));
    drop(room);
    drop(offline);

    // The next run shows the waiting message, and sends it once connected.
    let online = NudgeClient::new(
        config(&server.url, Some(cache.clone())),
        tokens(Some(&server.ann)),
    )
    .unwrap();
    let room = online.room("trip");
    assert_eq!(room.state().pending.len(), 1);
    online.open();
    let mut states = room.states();
    let state = until(&mut states, |s| settled(s) && s.pending.is_empty()).await;
    assert_eq!(user_texts(&state), ["Sent while offline"]);
    drop(room);
    drop(online);
    assert!(Cache::open(&cache).unwrap().outbox(None).is_empty());

    // Offline again: the room's last view is there at once, waiting for a snapshot.
    let offline = NudgeClient::new(
        config("http://127.0.0.1:9", Some(cache.clone())),
        tokens(Some(&server.ann)),
    )
    .unwrap();
    let room = offline.room("trip");
    let state = room.state();
    assert_eq!(state.status, SyncStatus::Syncing);
    assert_eq!(user_texts(&state), ["Sent while offline"]);
    std::fs::remove_dir_all(cache.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn stops_when_its_token_is_revoked_or_the_assistant_does_not_exist() {
    let Some(server) = faux_server().await else {
        return;
    };
    let admin = Api::new(&server.url, "robin", tokens(Some(&server.ann))).unwrap();
    let code = admin.pairing_code("bo").await.unwrap().code;
    let client = client(&server.url, None);
    let paired = client.api().pair(&code, client_info()).await.unwrap();
    let room = client.room("trip");
    client.open();
    let mut states = room.states();
    until(&mut states, |s| s.status == SyncStatus::Live).await;

    admin.revoke(&paired.client_id).await.unwrap();
    let mut statuses = client.connection().statuses();
    let closed = until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Closed { .. })
    })
    .await;
    assert!(
        matches!(closed, ConnectionStatus::Closed { code: 4401, .. }),
        "{closed:?}"
    );
    assert_eq!(client.api().me().await.unwrap_err().status(), Some(401));

    let lost = NudgeClient::new(
        ClientConfig {
            assistant: "nobody".into(),
            ..config(&server.url, None)
        },
        tokens(Some(&server.ann)),
    )
    .unwrap();
    let mut statuses = lost.connection().statuses();
    lost.open();
    until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Connecting { .. })
    })
    .await;
    let closed = until(&mut statuses, |s| {
        matches!(s, ConnectionStatus::Closed { .. })
    })
    .await;
    assert!(
        matches!(closed, ConnectionStatus::Closed { code: 4404, .. }),
        "{closed:?}"
    );
}
