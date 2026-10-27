//! Making a Nudge server on exe.dev from the app (ADR 11). exe.dev's HTTPS API takes its CLI's
//! commands at `POST https://exe.dev/exec`, with a bearer token the app mints from its own key once
//! the person signed in (`exe_login`), or one they minted on a computer and pasted; the token stays
//! on the device.
//!
//! What a command answers is read leniently: the shapes of `new` and `ls` aren't documented, so a
//! VM's address falls back to `https://<name>.exe.xyz`.

use std::collections::HashMap;
use std::time::Duration;

use rand::RngExt;
use serde_json::Value;
use url::Url;

use crate::api::ApiError;
use crate::protocol::ClientAction;
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
    /// The home server couldn't add the new server to its Wired network.
    #[error("Home's Wired: {0}")]
    Wired(String),
    /// Something this client won't put into an exe.dev command, such as a name with a space.
    #[error("{0}")]
    Invalid(String),
}

/// A VM on exe.dev, as far as Nudge needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExeVm {
    pub name: String,
    /// Where exe.dev's proxy serves it, such as `https://robin.exe.xyz`.
    pub url: String,
    /// Where SSH reaches it, when exe.dev said, such as `robin.exe.xyz`.
    pub ssh_host: Option<String>,
    /// Who SSH logs in as there, when exe.dev said.
    pub ssh_user: Option<String>,
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
    /// Where the newest release is named; none in tests, which then use the stable image.
    manifest: Option<&'static str>,
}

impl ExeDev {
    pub fn new(token: &str) -> Self {
        let mut exe = Self::with_base("https://exe.dev", token).expect("exe.dev's address parses");
        exe.manifest = Some(RELEASE_MANIFEST);
        exe
    }

    /// Another address than exe.dev's, for tests. It doesn't look the newest release up, so new
    /// servers get the stable image.
    pub fn with_base(base: &str, token: &str) -> Result<Self, ApiError> {
        Ok(ExeDev {
            base: Url::parse(base).map_err(|_| ApiError::Address(base.to_owned()))?,
            token: token.trim().to_owned(),
            http: reqwest::Client::new(),
            manifest: None,
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
        self.launch(name, wait, "").await
    }

    /// Like `launch_server`, and the new server joins `home`'s Wired network: home lists the
    /// relay it will serve at its exe.dev address and hands over the invite, so the two reach
    /// each other with no port open at home. `home` must hold the network (`enable_wired`).
    pub async fn launch_wired_server(
        &self,
        name: &str,
        wait: Duration,
        home: &crate::server::ServerApi,
    ) -> Result<LaunchedServer, ExeError> {
        let url = format!("https://{name}.exe.xyz");
        let invite = home
            .add_wired_relay(&url)
            .await
            .map_err(|e| ExeError::Wired(e.to_string()))?;
        // Both are plain [a-z0-9:/.-]: no quoting needed in exe.dev's command.
        if !invite.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(ExeError::Wired(
                "it gave an invite this can't pass on".into(),
            ));
        }
        self.launch(
            name,
            wait,
            &format!(" --env NUDGE_WIRED_INVITE={invite} --env NUDGE_WIRED_RELAY_URL={url}"),
        )
        .await
    }

    async fn launch(
        &self,
        name: &str,
        wait: Duration,
        extra_env: &str,
    ) -> Result<LaunchedServer, ExeError> {
        let code = new_setup_code();
        let image = self.newest_image().await;
        let answer = self
            .exec(&format!(
                "new --json --name {name} --image {image} --env NUDGE_SETUP_CODE={code} --env NUDGE_SETUP_MINUTES={SETUP_MINUTES}{extra_env}"
            ))
            .await?;
        let vm = vm_of(&answer).unwrap_or_else(|| ExeVm::named(name));
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
                .get(self.manifest?)
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
        check_name(name)?;
        self.exec(&format!("rm {name}")).await.map(drop)
    }

    /// Makes a plain VM named `name`, of `image` or exe.dev's default, such as for a project's
    /// coding agents.
    pub async fn new_vm(&self, name: &str, image: Option<&str>) -> Result<ExeVm, ExeError> {
        check_name(name)?;
        let mut command = format!("new --json --name {name}");
        if let Some(image) = image.filter(|image| !image.is_empty()) {
            if image
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "'\"\\".contains(c))
            {
                return Err(ExeError::Invalid(format!("Not an image name: {image}")));
            }
            command.push_str(&format!(" --image {image}"));
        }
        let answer = self.exec(&command).await?;
        Ok(vm_of(&answer).unwrap_or_else(|| ExeVm::named(name)))
    }

    /// Adds an SSH public key to the person's exe.dev account. One that is there already is fine.
    pub async fn add_ssh_key(&self, public_key: &str) -> Result<(), ExeError> {
        let key = public_key.trim();
        if key.is_empty() || key.chars().any(|c| c == '\'' || c.is_control()) {
            return Err(ExeError::Invalid("Not an SSH public key".into()));
        }
        match self.exec(&format!("ssh-key add '{key}'")).await {
            Ok(_) => Ok(()),
            Err(ExeError::Command(message) | ExeError::Status { message, .. })
                if message.to_ascii_lowercase().contains("already") =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    /// Does what an approval asks of the device before it is approved, and returns the inputs
    /// to approve it with: for `exe.new`, `vm` and `sshHost` (and `sshUser` when exe.dev named
    /// one, `sshKeyError` when the key couldn't be added); nothing for `exe.rm`.
    pub async fn run_client_action(
        &self,
        action: &ClientAction,
    ) -> Result<HashMap<String, String>, ExeError> {
        let mut inputs = HashMap::new();
        match action {
            ClientAction::ExeNew {
                name,
                image,
                ssh_key,
            } => {
                check_name(name)?;
                if let Some(key) = ssh_key.as_deref().filter(|key| !key.trim().is_empty()) {
                    // The VM is still worth making: the handler hears why the key isn't there.
                    if let Err(error) = self.add_ssh_key(key).await {
                        inputs.insert("sshKeyError".to_owned(), error.to_string());
                    }
                }
                let vm = self.new_vm(name, image.as_deref()).await?;
                let host = vm
                    .ssh_host
                    .clone()
                    .unwrap_or_else(|| format!("{}.exe.xyz", vm.name));
                if let Some(user) = vm.ssh_user {
                    inputs.insert("sshUser".to_owned(), user);
                }
                inputs.insert("vm".to_owned(), vm.name);
                inputs.insert("sshHost".to_owned(), host);
            }
            ClientAction::ExeRm { name } => self.delete(name).await?,
        }
        Ok(inputs)
    }
}

impl ExeVm {
    /// What a VM named `name` is when exe.dev said nothing about it.
    fn named(name: &str) -> Self {
        ExeVm {
            name: name.to_owned(),
            url: format!("https://{name}.exe.xyz"),
            ssh_host: None,
            ssh_user: None,
        }
    }
}

/// A VM's name as exe.dev takes it, and as safe in a command: `[a-z0-9][a-z0-9-]*`.
fn check_name(name: &str) -> Result<(), ExeError> {
    let mut chars = name.chars();
    let first = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if first && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        Ok(())
    } else {
        Err(ExeError::Invalid(format!("Not a VM name: {name}")))
    }
}

/// Where SSH reaches a VM, from what exe.dev said: `user@host`, `ssh user@host` or
/// `ssh://user@host`, as a host and the user when there is one.
fn ssh_dest_of(value: &Value) -> Option<(String, Option<String>)> {
    let dest = [
        "ssh_dest",
        "sshDest",
        "ssh_host",
        "sshHost",
        "ssh",
        "ssh_command",
    ]
    .iter()
    .find_map(|key| value.get(key).and_then(Value::as_str))?
    .trim();
    let dest = dest.strip_prefix("ssh://").unwrap_or(dest);
    let dest = dest.strip_prefix("ssh ").unwrap_or(dest).trim();
    let dest = dest
        .split_whitespace()
        .find(|part| !part.starts_with('-'))?;
    let (user, host) = match dest.rsplit_once('@') {
        Some((user, host)) => (Some(user.to_owned()).filter(|u| !u.is_empty()), host),
        None => (None, dest),
    };
    let host = host.trim_end_matches('/');
    (!host.is_empty()).then(|| (host.to_owned(), user))
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
    let (ssh_host, ssh_user) = ssh_dest_of(value).map_or((None, None), |(h, u)| (Some(h), u));
    Some(ExeVm {
        name,
        url,
        ssh_host,
        ssh_user,
    })
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
            Some(ExeVm::named("robin"))
        );
        assert_eq!(
            vm_of(&json!({ "vm_name": "robin", "https_url": "https://robin.exe.xyz/" }))
                .unwrap()
                .url,
            "https://robin.exe.xyz"
        );
        assert_eq!(vm_of(&json!({ "status": "running" })), None);
        let vm = vm_of(&json!({ "vm_name": "p1", "ssh_dest": "ssh dev@p1.exe.xyz" })).unwrap();
        assert_eq!(
            (vm.ssh_host.as_deref(), vm.ssh_user.as_deref()),
            (Some("p1.exe.xyz"), Some("dev"))
        );
        let vm = vm_of(&json!({ "name": "p1", "ssh": "p1.exe.xyz" })).unwrap();
        assert_eq!(
            (vm.ssh_host.as_deref(), vm.ssh_user),
            (Some("p1.exe.xyz"), None)
        );
    }

    #[test]
    fn puts_only_safe_names_into_commands() {
        assert!(check_name("proj-1").is_ok());
        assert!(check_name("1a").is_ok());
        for bad in ["", "-a", "Proj", "a b", "a;rm", "a_b"] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
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
