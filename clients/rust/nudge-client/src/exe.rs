//! Making a Nudge server on exe.dev from the app (ADR 11). exe.dev's HTTPS API takes its CLI's
//! commands at `POST https://exe.dev/exec`, with a bearer token the app mints from its own key once
//! the person signed in (`exe_login`), or one they minted on a computer and pasted; the token stays
//! on the device.
//!
//! What a command answers is read leniently: the shapes of `new` and `ls` aren't documented, so a
//! VM's address falls back to `https://<name>.exe.xyz`.

use std::time::Duration;

use rand::RngExt;
use serde_json::Value;
use url::Url;

use crate::api::ApiError;
use crate::server::setup_info;

/// The image a new server runs when the newest release can't be looked up: a Nudge release that
/// updates itself after.
pub const NUDGE_IMAGE: &str = "ghcr.io/lum1n/nudge:stable";
/// Where the newest release is named, as servers find it.
const RELEASE_MANIFEST: &str =
    "https://github.com/lum1n/nudge/releases/latest/download/manifest.json";
/// The port the image's server listens on, which exe.dev's proxy is pointed at.
pub const NUDGE_PORT: u16 = 8787;
/// How long a new server waits to be set up before it closes setup.
pub const SETUP_MINUTES: u32 = 30;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ExeError {
    /// exe.dev refused the token: wrong, expired, or not allowed that command (401, 403).
    #[error("exe.dev refused the token: {0}")]
    Token(String),
    /// The command ran and failed (422), such as a name in use.
    #[error("exe.dev: {0}")]
    Command(String),
    #[error("exe.dev answered {status}: {message}")]
    Status { status: u16, message: String },
    #[error("{0}")]
    Network(String),
    /// The new server didn't come up in time.
    #[error("The new server didn't answer: {0}")]
    NotUp(String),
}

/// A VM on exe.dev, as far as Nudge needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExeVm {
    pub name: String,
    /// Where exe.dev's proxy serves it, such as `https://robin.exe.xyz`.
    pub url: String,
}

/// A server made on exe.dev, waiting to be set up with `code` (`set_up`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchedServer {
    pub vm: ExeVm,
    pub code: String,
}

/// exe.dev's HTTPS API, with the person's token.
#[derive(Clone)]
pub struct ExeDev {
    base: Url,
    token: String,
    http: reqwest::Client,
}

impl ExeDev {
    pub fn new(token: &str) -> Self {
        Self::with_base("https://exe.dev", token).expect("exe.dev's address parses")
    }

    /// Another address than exe.dev's, for tests.
    pub fn with_base(base: &str, token: &str) -> Result<Self, ApiError> {
        Ok(ExeDev {
            base: Url::parse(base).map_err(|_| ApiError::Address(base.to_owned()))?,
            token: token.trim().to_owned(),
            http: reqwest::Client::new(),
        })
    }

    /// Runs one exe.dev command, such as `ls`, and returns what it answered.
    pub async fn exec(&self, command: &str) -> Result<Value, ExeError> {
        let mut url = self.base.clone();
        url.set_path("/exec");
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.token)
            .body(command.to_owned())
            .send()
            .await
            .map_err(|error| ExeError::Network(error.to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|error| ExeError::Network(error.to_string()))?;
        match status {
            200..=299 => Ok(serde_json::from_str(&text).unwrap_or(Value::String(text))),
            401 | 403 => Err(ExeError::Token(message_of(&text))),
            422 => Err(ExeError::Command(message_of(&text))),
            _ => Err(ExeError::Status {
                status,
                message: message_of(&text),
            }),
        }
    }

    /// Who the token belongs to, as a check that it works.
    pub async fn whoami(&self) -> Result<Value, ExeError> {
        self.exec("whoami").await
    }

    pub async fn list(&self) -> Result<Vec<ExeVm>, ExeError> {
        let answer = self.exec("ls --json").await?;
        let items = answer
            .get("vms")
            .and_then(Value::as_array)
            .or_else(|| answer.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(items.iter().filter_map(vm_of).collect())
    }

    /// Makes a VM running the Nudge image, waiting to be set up with a fresh code, and makes its
    /// address public: people sign in with Nudge's own tokens, not an exe.dev login. Then waits
    /// until its setup answers, at most `wait`.
    pub async fn launch_server(
        &self,
        name: &str,
        wait: Duration,
    ) -> Result<LaunchedServer, ExeError> {
        let code = new_setup_code();
        let image = self.newest_image().await;
        let answer = self
            .exec(&format!(
                "new --json --name {name} --image {image} --env NUDGE_SETUP_CODE={code} --env NUDGE_SETUP_MINUTES={SETUP_MINUTES}"
            ))
            .await?;
        let vm = vm_of(&answer).unwrap_or_else(|| ExeVm {
            name: name.to_owned(),
            url: format!("https://{name}.exe.xyz"),
        });
        self.exec(&format!("share port {} {NUDGE_PORT}", vm.name))
            .await?;
        self.exec(&format!("share set-public {}", vm.name)).await?;
        wait_for_setup(&vm.url, wait).await?;
        Ok(LaunchedServer { vm, code })
    }

    /// The newest release's own image, such as `ghcr.io/lum1n/nudge:0.3.1`: exe.dev keeps an image
    /// it pulled by its tag, so `stable` could start a new server on an old release. The stable
    /// image when the release can't be looked up.
    async fn newest_image(&self) -> String {
        let version = async {
            let response = self
                .http
                .get(RELEASE_MANIFEST)
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .ok()?;
            let manifest: Value = response.error_for_status().ok()?.json().await.ok()?;
            manifest.get("version")?.as_str().map(str::to_owned)
        }
        .await;
        match version {
            Some(version) if is_release_version(&version) => {
                format!("ghcr.io/lum1n/nudge:{version}")
            }
            _ => NUDGE_IMAGE.to_owned(),
        }
    }

    /// Removes the VM and everything on it. Back it up and delete its assistants first, so their
    /// guests' homes are told.
    pub async fn delete(&self, name: &str) -> Result<(), ExeError> {
        self.exec(&format!("rm {name}")).await.map(drop)
    }
}

/// Polls `server`'s setup until it answers open, every two seconds, at most `wait`.
pub async fn wait_for_setup(server: &str, wait: Duration) -> Result<(), ExeError> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match setup_info(server).await {
            Ok(info) if info.open => return Ok(()),
            Ok(_) => return Err(ExeError::NotUp("it is set up already".into())),
            Err(error) if tokio::time::Instant::now() >= deadline => {
                return Err(ExeError::NotUp(error.to_string()));
            }
            Err(_) => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
}

/// A release's version as its image is tagged: `0.3.1`, numbers only.
fn is_release_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// A setup code as servers make them: `XXXX-XXXX-XXXX` in Crockford's base 32.
pub fn new_setup_code() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut rng = rand::rng();
    let chars: Vec<char> = (0..12)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect();
    chars
        .chunks(4)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// A VM from what exe.dev said about it: its name, and its HTTPS address when it gave one.
fn vm_of(value: &Value) -> Option<ExeVm> {
    let name = ["name", "vm_name", "vmname", "vm"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))?
        .to_owned();
    let url = ["https_url", "url", "proxy_url", "https"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .map(|url| url.trim_end_matches('/').to_owned())
        .unwrap_or_else(|| format!("https://{name}.exe.xyz"));
    Some(ExeVm { name, url })
}

fn message_of(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            ["error", "message", "output"]
                .iter()
                .find_map(|key| value.get(key).and_then(Value::as_str).map(str::to_owned))
        })
        .unwrap_or_else(|| text.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_vms_leniently() {
        assert_eq!(
            vm_of(&json!({ "name": "robin" })),
            Some(ExeVm {
                name: "robin".into(),
                url: "https://robin.exe.xyz".into()
            })
        );
        assert_eq!(
            vm_of(&json!({ "vm_name": "robin", "https_url": "https://robin.exe.xyz/" }))
                .unwrap()
                .url,
            "https://robin.exe.xyz"
        );
        assert_eq!(vm_of(&json!({ "status": "running" })), None);
    }

    #[test]
    fn tags_images_only_with_release_versions() {
        assert!(is_release_version("0.3.1"));
        assert!(is_release_version("10.20.30"));
        assert!(!is_release_version("0.3.1-beta.1"));
        assert!(!is_release_version("0.3"));
        assert!(!is_release_version("0.3.1 --env X=1"));
    }

    #[test]
    fn makes_setup_codes_servers_take() {
        let code = new_setup_code();
        assert_eq!(code.len(), 14);
        assert!(
            code.chars()
                .all(|c| c == '-' || "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c))
        );
    }
}
