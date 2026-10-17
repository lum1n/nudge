//! Signing in to exe.dev from the app, without a computer (ADR 11). The app makes an SSH key of its
//! own and opens `ssh exe.dev` with it, whose screen it shows: exe.dev asks for the person's email
//! and sends them a link, which adds the key to their account, new or not. The app's exe.dev token
//! is minted from the same key on the device, so it works once the key is added.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use russh::client::{self, Handle};
use russh::keys::{Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::exe::ExeError;

/// exe.dev's host key, as its documentation gives it (https://exe.dev/docs/faq/host-key).
pub const EXE_HOST_KEY: &str = "SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo";

/// What the app's token may run: what making a server, listing and removing them needs.
pub const EXE_TOKEN_COMMANDS: &[&str] = &[
    "whoami",
    "ls",
    "new",
    "rm",
    "share show",
    "share port",
    "share set-public",
];

/// How often the screen is passed on at most, while it changes.
const SCREEN_EVERY: Duration = Duration::from_millis(80);

/// An SSH key of the app's, in OpenSSH's formats.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExeKey {
    pub private_key: String,
    /// `ssh-ed25519 AAAA… nudge`, as exe.dev lists it.
    pub public_key: String,
}

/// Makes an Ed25519 key for exe.dev.
pub fn new_exe_key() -> Result<ExeKey, ExeError> {
    let mut key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).map_err(key_error)?;
    key.set_comment("nudge");
    Ok(ExeKey {
        private_key: key
            .to_openssh(Default::default())
            .map_err(key_error)?
            .to_string(),
        public_key: key.public_key().to_openssh().map_err(key_error)?,
    })
}

/// An `exe0` token for the HTTPS API, signed with `private_key` (exe.dev's "local key creation"):
/// the permissions as JSON, and their SSH signature in the `v0@exe.dev` namespace, each base64url.
/// `expires` is a Unix time; without one the token doesn't expire.
pub fn mint_exe_token(private_key: &str, expires: Option<u64>) -> Result<String, ExeError> {
    let key = PrivateKey::from_openssh(private_key).map_err(key_error)?;
    let mut permissions = json!({ "cmds": EXE_TOKEN_COMMANDS });
    if let Some(expires) = expires {
        permissions["exp"] = expires.into();
    }
    let permissions = permissions.to_string();
    let signature = key
        .sign("v0@exe.dev", HashAlg::Sha512, permissions.as_bytes())
        .map_err(key_error)?;
    // The PEM's body is the signature blob in standard base64.
    let pem = signature.to_pem(Default::default()).map_err(key_error)?;
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let blob = STANDARD
        .decode(body.trim())
        .map_err(|error| ExeError::Network(format!("signing the token: {error}")))?;
    Ok(format!(
        "exe0.{}.{}",
        URL_SAFE_NO_PAD.encode(permissions),
        URL_SAFE_NO_PAD.encode(blob)
    ))
}

fn key_error(error: impl std::fmt::Display) -> ExeError {
    ExeError::Network(format!("the exe.dev key: {error}"))
}

/// What a login session tells the app, on the library's threads.
pub trait ExeScreen: Send + Sync + 'static {
    /// The terminal's screen as text, a line per row, when it changed.
    fn screen(&self, text: String);
    /// The session ended: exe.dev closed it, or it failed with `problem`.
    fn closed(&self, problem: Option<String>);
}

/// `ssh exe.dev` with the app's key, its screen kept by a terminal parser. Dropping it ends it.
pub struct ExeLogin {
    input: mpsc::UnboundedSender<Input>,
    task: JoinHandle<()>,
}

enum Input {
    Bytes(Vec<u8>),
    Resize(u16, u16),
}

impl ExeLogin {
    /// Connects, checking exe.dev's host key, and opens a terminal of `cols` × `rows`. Fails when
    /// exe.dev can't be reached or the key isn't taken; after that, the end comes to `screen`.
    pub async fn start(
        private_key: &str,
        cols: u16,
        rows: u16,
        screen: Arc<dyn ExeScreen>,
    ) -> Result<ExeLogin, ExeError> {
        Self::start_at("exe.dev:22", EXE_HOST_KEY, private_key, cols, rows, screen).await
    }

    /// Another host than exe.dev, for tests.
    pub async fn start_at(
        address: &str,
        host_key: &str,
        private_key: &str,
        cols: u16,
        rows: u16,
        screen: Arc<dyn ExeScreen>,
    ) -> Result<ExeLogin, ExeError> {
        let key = PrivateKey::from_openssh(private_key).map_err(key_error)?;
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(20)),
            ..Default::default()
        });
        let checker = HostKey(host_key.to_owned());
        let mut session = client::connect(config, address, checker)
            .await
            .map_err(|error| ExeError::Network(format!("exe.dev: {error}")))?;
        // exe.dev takes any name; it knows people by their keys.
        let auth = session
            .authenticate_publickey("nudge", PrivateKeyWithHashAlg::new(Arc::new(key), None))
            .await
            .map_err(ssh_error)?;
        if !auth.success() {
            return Err(ExeError::Network("exe.dev didn't take the key.".into()));
        }
        let channel = session.channel_open_session().await.map_err(ssh_error)?;
        channel
            .request_pty(false, "xterm-256color", cols.into(), rows.into(), 0, 0, &[])
            .await
            .map_err(ssh_error)?;
        channel.request_shell(false).await.map_err(ssh_error)?;
        let (input, inputs) = mpsc::unbounded_channel();
        let task = tokio::spawn(follow(session, channel, inputs, cols, rows, screen));
        Ok(ExeLogin { input, task })
    }

    /// Types `text` into the terminal, as is: end a line with `\r`.
    pub fn send(&self, text: &str) {
        let _ = self.input.send(Input::Bytes(text.as_bytes().to_vec()));
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.input.send(Input::Resize(cols, rows));
    }
}

impl Drop for ExeLogin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn follow(
    session: Handle<HostKey>,
    mut channel: russh::Channel<client::Msg>,
    mut inputs: mpsc::UnboundedReceiver<Input>,
    cols: u16,
    rows: u16,
    screen: Arc<dyn ExeScreen>,
) {
    let mut parser = vt100::Parser::new(rows, cols, 0);
    let mut tick = tokio::time::interval(SCREEN_EVERY);
    let mut changed = false;
    let mut shown = String::new();
    let problem = loop {
        tokio::select! {
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    parser.process(&data);
                    changed = true;
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break None,
                Some(ChannelMsg::ExitStatus { .. }) => break None,
                _ => {}
            },
            input = inputs.recv() => match input {
                Some(Input::Bytes(bytes)) => {
                    if let Err(error) = channel.data(&bytes[..]).await {
                        break Some(error.to_string());
                    }
                }
                Some(Input::Resize(cols, rows)) => {
                    parser.screen_mut().set_size(rows, cols);
                    changed = true;
                    let _ = channel.window_change(cols.into(), rows.into(), 0, 0).await;
                }
                None => break None,
            },
            _ = tick.tick(), if changed => {
                changed = false;
                let text = parser.screen().contents();
                if text != shown {
                    shown = text.clone();
                    screen.screen(text);
                }
            }
        }
    };
    let text = parser.screen().contents();
    if text != shown {
        screen.screen(text);
    }
    let _ = session
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;
    screen.closed(problem);
}

fn ssh_error(error: russh::Error) -> ExeError {
    ExeError::Network(format!("exe.dev: {error}"))
}

/// Takes the server only when its key has the fingerprint given.
struct HostKey(String);

impl client::Handler for HostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mints_a_token_exe_can_read() {
        let key = new_exe_key().unwrap();
        assert!(key.public_key.starts_with("ssh-ed25519 "));
        let token = mint_exe_token(&key.private_key, Some(2_000_000_000)).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "exe0");
        let permissions: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(permissions["exp"], 2_000_000_000);
        assert_eq!(permissions["cmds"][0], "whoami");
        // The blob is an SSHSIG, which the key verifies.
        let blob = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(&blob[..6], b"SSHSIG");
        let pem = format!(
            "-----BEGIN SSH SIGNATURE-----\n{}\n-----END SSH SIGNATURE-----\n",
            STANDARD.encode(&blob)
        );
        let signature = russh::keys::ssh_key::SshSig::from_pem(pem).unwrap();
        let private = PrivateKey::from_openssh(&key.private_key).unwrap();
        private
            .public_key()
            .verify(
                "v0@exe.dev",
                URL_SAFE_NO_PAD.decode(parts[1]).unwrap().as_slice(),
                &signature,
            )
            .unwrap();
    }
}
