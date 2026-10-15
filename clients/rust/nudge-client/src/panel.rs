use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use url::Url;

use crate::api::{ApiError, TokenStore, endpoint};
use crate::connection::Backoff;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelStatus {
    /// Opening the socket, or waiting for `ready`; also after it dropped, until it is back.
    Connecting,
    Open,
    /// Given up: `close()` was called (1000), the token is bad (4401), or there is no such
    /// assistant, room or extension socket here (4404).
    Closed {
        code: u16,
        reason: String,
    },
}

/// What a `PanelSocket` hands the extension's frames to, on the socket's task.
pub trait PanelListener: Send + Sync {
    fn status(&self, status: PanelStatus);
    /// A frame of the extension's own, as JSON: its view, `ok` and `error` replies, …
    fn frame(&self, frame: Value);
}

/// The socket address of an extension's panel for a room.
pub fn panel_url(
    server: &str,
    assistant: &str,
    room: &str,
    extension: &str,
) -> Result<Url, ApiError> {
    let invalid = || ApiError::Address(server.to_owned());
    let base = Url::parse(server).map_err(|_| invalid())?;
    let mut url = endpoint(
        &base,
        &["v1", "a", assistant, "rooms", room, "ext", extension],
    );
    let scheme = match base.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err(invalid()),
    };
    url.set_scheme(scheme).map_err(|_| invalid())?;
    Ok(url)
}

/// One room's socket to an extension's panel (`/ext/<extension>`), such as the lists or the
/// documents: it says hello with the token, waits for `ready`, then hands every frame to the
/// listener and sends what `send` gets. It reconnects with backoff when the socket drops, and
/// gives up on 4401 and 4404. The frames are the extension's; extensions send their whole view
/// again after a reconnect.
///
/// The task ends when the socket is dropped or closed. Make one inside a Tokio runtime.
pub struct PanelSocket {
    commands: mpsc::UnboundedSender<PanelCommand>,
}

enum PanelCommand {
    Send(String),
    Close,
}

impl PanelSocket {
    pub fn open(
        url: Url,
        tokens: Arc<dyn TokenStore>,
        listener: Arc<dyn PanelListener>,
        backoff: Backoff,
    ) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        tokio::spawn(run(url, tokens, listener, backoff, receiver));
        PanelSocket { commands }
    }

    /// Sends a frame; while the socket opens it waits, while it waits to reconnect it is dropped.
    pub fn send(&self, frame: &Value) {
        let _ = self.commands.send(PanelCommand::Send(frame.to_string()));
    }

    pub fn close(&self) {
        let _ = self.commands.send(PanelCommand::Close);
    }
}

impl Drop for PanelSocket {
    fn drop(&mut self) {
        let _ = self.commands.send(PanelCommand::Close);
    }
}

/// Close codes after which trying again can't help.
fn gives_up(code: u16) -> bool {
    matches!(code, 4400 | 4401 | 4403 | 4404)
}

async fn run(
    url: Url,
    tokens: Arc<dyn TokenStore>,
    listener: Arc<dyn PanelListener>,
    backoff: Backoff,
    mut commands: mpsc::UnboundedReceiver<PanelCommand>,
) {
    let mut attempt: u32 = 0;
    loop {
        listener.status(PanelStatus::Connecting);
        let Some(token) = tokens.get() else {
            return listener.status(PanelStatus::Closed {
                code: 4401,
                reason: "No token".into(),
            });
        };
        let (code, reason) = match session(&url, &token, &*listener, &mut commands).await {
            Ended::ByUs => {
                return listener.status(PanelStatus::Closed {
                    code: 1000,
                    reason: String::new(),
                });
            }
            Ended::Opened(code, reason) => {
                attempt = 0;
                (code, reason)
            }
            Ended::Failed(code, reason) => (code, reason),
        };
        if gives_up(code) {
            return listener.status(PanelStatus::Closed { code, reason });
        }
        attempt += 1;
        let delay = backoff
            .start
            .saturating_mul(1 << (attempt - 1).min(16))
            .min(backoff.max)
            .mul_f64(0.5 + rand::random::<f64>() / 2.0);
        // Waiting, but a close still ends it at once; frames sent meanwhile are dropped.
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                command = commands.recv() => match command {
                    None | Some(PanelCommand::Close) => {
                        return listener.status(PanelStatus::Closed {
                            code: 1000,
                            reason: String::new(),
                        });
                    }
                    Some(PanelCommand::Send(_)) => {}
                },
            }
        }
    }
}

enum Ended {
    ByUs,
    /// Lost after `ready`.
    Opened(u16, String),
    /// Lost before `ready`.
    Failed(u16, String),
}

async fn session(
    url: &Url,
    token: &str,
    listener: &dyn PanelListener,
    commands: &mut mpsc::UnboundedReceiver<PanelCommand>,
) -> Ended {
    let connecting = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async(url.as_str()),
    );
    let mut socket = match connecting.await {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(error)) => return Ended::Failed(1006, error.to_string()),
        Err(_) => return Ended::Failed(1006, "Timed out".into()),
    };
    let hello = json!({ "type": "hello", "token": token }).to_string();
    if let Err(error) = socket.send(Message::text(hello)).await {
        return Ended::Failed(1006, error.to_string());
    }
    // Shown as open, and the server's `ready` seen: it drops frames until then.
    let mut open = false;
    let mut ready = false;
    let mut waiting: Vec<String> = Vec::new();
    let lost = |open: bool, code: u16, reason: String| {
        if open {
            Ended::Opened(code, reason)
        } else {
            Ended::Failed(code, reason)
        }
    };
    loop {
        tokio::select! {
            message = socket.next() => match message {
                None => return lost(open, 1006, String::new()),
                Some(Err(error)) => return lost(open, 1006, error.to_string()),
                Some(Ok(Message::Text(text))) => {
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                    // The extension may send its view before the server's `ready`: any frame
                    // means the hello was taken.
                    if !open {
                        open = true;
                        listener.status(PanelStatus::Open);
                    }
                    if frame["type"] != "ready" {
                        listener.frame(frame);
                        continue;
                    }
                    ready = true;
                    for text in waiting.drain(..) {
                        if let Err(error) = socket.send(Message::text(text)).await {
                            return lost(open, 1006, error.to_string());
                        }
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((1005, String::new()));
                    return lost(open, code, reason);
                }
                Some(Ok(_)) => {}
            },
            command = commands.recv() => match command {
                None | Some(PanelCommand::Close) => {
                    let _ = socket
                        .close(Some(CloseFrame { code: CloseCode::Normal, reason: "".into() }))
                        .await;
                    return Ended::ByUs;
                }
                Some(PanelCommand::Send(text)) if !ready => waiting.push(text),
                Some(PanelCommand::Send(text)) => {
                    if let Err(error) = socket.send(Message::text(text)).await {
                        return lost(open, 1006, error.to_string());
                    }
                }
            },
        }
    }
}
