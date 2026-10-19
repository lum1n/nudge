//! The server's own API, setup, and making servers on exe.dev (ADR 11), for the apps.

use std::sync::Arc;
use std::time::Duration;

use nudge_client::protocol as p;
use nudge_client::{ExeError, ServerApi};

use crate::{ForeignTokens, NudgeError, Player, TokenStore, run};

impl From<ExeError> for NudgeError {
    fn from(error: ExeError) -> Self {
        let detail = error.to_string();
        match error {
            ExeError::Token(_) => NudgeError::Status {
                status: 401,
                detail,
            },
            ExeError::Command(_) => NudgeError::Status {
                status: 422,
                detail,
            },
            ExeError::Status { status, .. } => NudgeError::Status { status, detail },
            ExeError::Network(_) | ExeError::NotUp(_) | ExeError::Wired(_) => {
                NudgeError::Network { detail }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ModelChoice {
    pub provider: String,
    pub model_id: String,
}

/// Monthly limits on model spend, in US dollars; `warn_at` is a share between 0 and 1.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AssistantBudget {
    pub monthly_usd: Option<f64>,
    pub per_player_usd: Option<f64>,
    pub warn_at: Option<f64>,
}

/// An assistant's settings, as the owner edits them; saved whole.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AssistantSettings {
    pub display_name: String,
    pub model: ModelChoice,
    pub time_zone: Option<String>,
    pub instructions: Option<String>,
    pub budget: Option<AssistantBudget>,
}

/// One of the server's assistants.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ServerAssistant {
    /// In its URLs and its people's addresses; it never changes.
    pub name: String,
    pub settings: AssistantSettings,
    /// False when it is in the config but failed to open.
    pub running: bool,
}

/// Who a new assistant is for.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum AssistantFor {
    /// The owner, who joins it from home with their address.
    Me { address: String },
    /// Someone whose home it is, with their pairing code to give them.
    SomeonesHome { display_name: String },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct NewAssistant {
    /// Lower-case letters, digits and dashes; part of every address, so it can't change.
    pub name: String,
    pub settings: AssistantSettings,
    pub made_for: AssistantFor,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FirstPlayerPairing {
    pub code: String,
    /// `nudge://pair?server=…&assistant=…&code=…`, for a QR code.
    pub link: String,
    pub expires_at: f64,
    pub player_id: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct MadeAssistant {
    pub assistant: ServerAssistant,
    /// For someone's home: their pairing code.
    pub pairing: Option<FirstPlayerPairing>,
    /// For the owner: `nudge://join?…`, which the app follows to join from home.
    pub join_link: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Enum)]
pub enum KeySource {
    /// The server's environment, which wins.
    Env,
    Server,
    Assistant,
    None,
}

/// Where a provider's key comes from; the key itself is never shown.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ProviderKey {
    pub provider: String,
    pub source: KeySource,
    /// For `Env`: which variables.
    pub variables: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ServerOwner {
    pub id: String,
    pub assistant: String,
    pub player_id: String,
    pub added_at: f64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct UpdateState {
    pub current: String,
    pub automatic: bool,
    pub available: Option<String>,
    pub checked_at: Option<f64>,
    pub error: Option<String>,
}

/// How far the server's own Tailscale is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TailscaleStatus {
    Off,
    Starting,
    /// Someone approves it at `auth_url`.
    NeedsLogin,
    /// A tailnet admin approves the machine.
    NeedsApproval,
    Connected,
    Error,
}

/// The server's own Tailscale, so it can reach assistants only in its owner's tailnet.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct TailscaleState {
    pub state: TailscaleStatus,
    pub auth_url: Option<String>,
    /// Its MagicDNS name, such as `nudge-robin.tail1234.ts.net`.
    pub name: Option<String>,
    pub addresses: Vec<String>,
    pub error: Option<String>,
}

/// How far the server's Wired is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum WiredStatus {
    Off,
    /// This release has no Wired.
    Unavailable,
    Starting,
    /// This server holds the network.
    Root,
    /// It joined one.
    Member,
    Error,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct WiredMember {
    pub name: String,
    /// Whether it holds the network.
    pub anchor: bool,
}

/// The server's Wired: an encrypted network between Nudge servers that needs no open port at
/// home. Other servers reach this one's API at `http://nudge.<name>.wired`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct WiredState {
    pub state: WiredStatus,
    pub name: Option<String>,
    pub members: Vec<WiredMember>,
    /// The network's relays: public addresses every server reaches the others through.
    pub relays: Vec<String>,
    /// The relay this server serves, at its public address.
    pub relay: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ServerInfo {
    pub version: String,
    pub owner: ServerOwner,
    pub assistants: Vec<ServerAssistant>,
    pub updates: Option<UpdateState>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SetupModel {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SetupProvider {
    pub id: String,
    pub name: String,
    pub models: Vec<SetupModel>,
    pub recommended: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SetupLocalServer {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
}

/// What a server in setup mode offers; `open` is false once it is set up.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SetupInfo {
    pub open: bool,
    pub providers: Vec<SetupProvider>,
    pub local: Vec<SetupLocalServer>,
}

/// What the setup wizard asks.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SetupChoices {
    pub code: String,
    pub assistant_name: String,
    pub display_name: Option<String>,
    pub model: ModelChoice,
    /// The provider's key; `None` with `local`.
    pub key: Option<String>,
    /// The id of a found local model server.
    pub local: Option<String>,
    /// The person setting it up: its first player and admin, and the server's owner.
    pub your_name: String,
    /// The address the app reached the server at.
    pub public_url: Option<String>,
    pub backups: bool,
}

/// The tokens are shown only here: the player's for the assistant, the owner's for the server.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SetupResult {
    pub assistant: String,
    pub player: Player,
    pub token: String,
    pub client_id: String,
    pub server_token: String,
    pub owner: ServerOwner,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ExeVm {
    pub name: String,
    /// Such as `https://robin.exe.xyz`.
    pub url: String,
}

/// The app's own SSH key for exe.dev, in OpenSSH's formats. Keep `private_key` in the keychain.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ExeKey {
    pub private_key: String,
    pub public_key: String,
}

/// A server made on exe.dev, waiting to be set up with `code`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct LaunchedServer {
    pub vm: ExeVm,
    pub code: String,
}

impl From<p::ModelChoice> for ModelChoice {
    fn from(m: p::ModelChoice) -> Self {
        ModelChoice {
            provider: m.provider,
            model_id: m.model_id,
        }
    }
}

impl From<ModelChoice> for p::ModelChoice {
    fn from(m: ModelChoice) -> Self {
        p::ModelChoice {
            provider: m.provider,
            model_id: m.model_id,
        }
    }
}

impl From<p::AssistantBudget> for AssistantBudget {
    fn from(b: p::AssistantBudget) -> Self {
        AssistantBudget {
            monthly_usd: b.monthly_usd,
            per_player_usd: b.per_player_usd,
            warn_at: b.warn_at,
        }
    }
}

impl From<AssistantBudget> for p::AssistantBudget {
    fn from(b: AssistantBudget) -> Self {
        p::AssistantBudget {
            monthly_usd: b.monthly_usd,
            per_player_usd: b.per_player_usd,
            warn_at: b.warn_at,
        }
    }
}

impl From<p::ServerAssistant> for ServerAssistant {
    fn from(a: p::ServerAssistant) -> Self {
        ServerAssistant {
            name: a.name,
            settings: AssistantSettings {
                display_name: a.display_name,
                model: a.model.into(),
                time_zone: a.time_zone,
                instructions: a.instructions,
                budget: a.budget.map(Into::into),
            },
            running: a.running,
        }
    }
}

impl From<p::ServerOwner> for ServerOwner {
    fn from(o: p::ServerOwner) -> Self {
        ServerOwner {
            id: o.id,
            assistant: o.assistant,
            player_id: o.player_id,
            added_at: o.added_at,
        }
    }
}

impl From<p::UpdateState> for UpdateState {
    fn from(u: p::UpdateState) -> Self {
        UpdateState {
            current: u.current,
            automatic: u.automatic,
            available: u.available,
            checked_at: u.checked_at,
            error: u.error,
        }
    }
}

impl From<p::TailscaleState> for TailscaleState {
    fn from(t: p::TailscaleState) -> Self {
        TailscaleState {
            state: match t.state {
                p::TailscaleStatus::Off => TailscaleStatus::Off,
                p::TailscaleStatus::Starting => TailscaleStatus::Starting,
                p::TailscaleStatus::NeedsLogin => TailscaleStatus::NeedsLogin,
                p::TailscaleStatus::NeedsApproval => TailscaleStatus::NeedsApproval,
                p::TailscaleStatus::Connected => TailscaleStatus::Connected,
                p::TailscaleStatus::Error => TailscaleStatus::Error,
            },
            auth_url: t.auth_url,
            name: t.name,
            addresses: t.addresses.unwrap_or_default(),
            error: t.error,
        }
    }
}

impl From<p::WiredState> for WiredState {
    fn from(w: p::WiredState) -> Self {
        WiredState {
            state: match w.state {
                p::WiredStatus::Off => WiredStatus::Off,
                p::WiredStatus::Unavailable => WiredStatus::Unavailable,
                p::WiredStatus::Starting => WiredStatus::Starting,
                p::WiredStatus::Root => WiredStatus::Root,
                p::WiredStatus::Member => WiredStatus::Member,
                p::WiredStatus::Error => WiredStatus::Error,
            },
            name: w.name,
            members: w
                .members
                .unwrap_or_default()
                .into_iter()
                .map(|m| WiredMember {
                    name: m.name,
                    anchor: m.anchor,
                })
                .collect(),
            relays: w.relays.unwrap_or_default(),
            relay: w.relay,
            error: w.error,
        }
    }
}

impl From<p::ProviderKey> for ProviderKey {
    fn from(k: p::ProviderKey) -> Self {
        ProviderKey {
            provider: k.provider,
            source: match k.source {
                p::KeySource::Env => KeySource::Env,
                p::KeySource::Server => KeySource::Server,
                p::KeySource::Assistant => KeySource::Assistant,
                p::KeySource::None => KeySource::None,
            },
            variables: k.variables.unwrap_or_default(),
        }
    }
}

fn client_info(client_name: &str, platform: &str) -> p::ClientInfo {
    p::ClientInfo {
        name: client_name.to_owned(),
        platform: platform.to_owned(),
    }
}

/// The server's own API, signed in as one of its owners with a server token in `tokens`.
#[derive(uniffi::Object)]
pub struct ServerClient {
    api: ServerApi,
    info: p::ClientInfo,
}

#[uniffi::export]
impl ServerClient {
    /// `server` is its address; `client_name` and `platform` say what this app is, as for
    /// `NudgeClient`.
    #[uniffi::constructor]
    pub fn new(
        server: String,
        tokens: Arc<dyn TokenStore>,
        client_name: String,
        platform: String,
    ) -> Result<Arc<Self>, NudgeError> {
        Ok(Arc::new(ServerClient {
            api: ServerApi::new(&server, Arc::new(ForeignTokens(tokens)))?,
            info: client_info(&client_name, &platform),
        }))
    }

    /// Trades the player token of an owner, on `assistant`, for a server token, and stores it.
    pub async fn sign_in(
        &self,
        assistant: String,
        player_token: String,
    ) -> Result<ServerOwner, NudgeError> {
        let (api, info) = (self.api.clone(), self.info.clone());
        let session =
            run(async move { api.sign_in(&assistant, &player_token, info).await }).await?;
        Ok(session.owner.into())
    }

    pub async fn sign_out(&self) -> Result<(), NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.sign_out().await }).await?)
    }

    pub async fn info(&self) -> Result<ServerInfo, NudgeError> {
        let api = self.api.clone();
        let info = run(async move { api.info().await }).await?;
        Ok(ServerInfo {
            version: info.version,
            owner: info.owner.into(),
            assistants: info.assistants.into_iter().map(Into::into).collect(),
            updates: info.updates.map(Into::into),
        })
    }

    pub async fn assistants(&self) -> Result<Vec<ServerAssistant>, NudgeError> {
        let api = self.api.clone();
        let assistants = run(async move { api.assistants().await }).await?;
        Ok(assistants.into_iter().map(Into::into).collect())
    }

    /// For the owner, with their address: they then join it from home with `join_link`. For
    /// someone's home: their pairing code.
    pub async fn create_assistant(&self, new: NewAssistant) -> Result<MadeAssistant, NudgeError> {
        let settings = new.settings;
        let (first_player, invite) = match new.made_for {
            AssistantFor::Me { address } => (None, Some(address)),
            AssistantFor::SomeonesHome { display_name } => {
                (Some(p::FirstPlayer { display_name }), None)
            }
        };
        let body = p::CreateAssistantRequest {
            name: new.name,
            display_name: Some(settings.display_name),
            model: Some(settings.model.into()),
            time_zone: settings.time_zone,
            instructions: settings.instructions,
            budget: settings.budget.map(Into::into),
            first_player,
            invite,
        };
        let api = self.api.clone();
        let made = run(async move { api.create_assistant(&body).await }).await?;
        Ok(MadeAssistant {
            assistant: made.assistant.into(),
            pairing: made.pairing.map(|pairing| FirstPlayerPairing {
                code: pairing.code,
                link: pairing.link,
                expires_at: pairing.expires_at,
                player_id: pairing.player_id,
            }),
            join_link: made.join_link,
        })
    }

    /// Saves the settings whole; the assistant reopens with them.
    pub async fn update_assistant(
        &self,
        name: String,
        settings: AssistantSettings,
    ) -> Result<ServerAssistant, NudgeError> {
        let change = p::UpdateAssistantRequest {
            display_name: Some(Some(settings.display_name)),
            model: Some(Some(settings.model.into())),
            time_zone: Some(settings.time_zone),
            instructions: Some(settings.instructions),
            budget: Some(settings.budget.map(Into::into)),
        };
        let api = self.api.clone();
        Ok(
            run(async move { api.update_assistant(&name, &change).await })
                .await?
                .into(),
        )
    }

    /// Deletes it for good, after a backup the server keeps for a while; returns its name.
    pub async fn delete_assistant(&self, name: String) -> Result<String, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.delete_assistant(&name).await }).await?)
    }

    pub async fn keys(&self, assistant: Option<String>) -> Result<Vec<ProviderKey>, NudgeError> {
        let api = self.api.clone();
        let keys = run(async move { api.keys(assistant.as_deref()).await }).await?;
        Ok(keys.into_iter().map(Into::into).collect())
    }

    /// Kept once a tiny request with it worked; a 400 has the provider's answer.
    pub async fn set_key(
        &self,
        provider: String,
        key: String,
        assistant: Option<String>,
    ) -> Result<ProviderKey, NudgeError> {
        let body = p::SetProviderKeyRequest {
            key,
            assistant,
            test: None,
        };
        let api = self.api.clone();
        Ok(run(async move { api.set_key(&provider, &body).await })
            .await?
            .into())
    }

    pub async fn delete_key(
        &self,
        provider: String,
        assistant: Option<String>,
    ) -> Result<(), NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.delete_key(&provider, assistant.as_deref()).await }).await?)
    }

    pub async fn owners(&self) -> Result<Vec<ServerOwner>, NudgeError> {
        let api = self.api.clone();
        let owners = run(async move { api.owners().await }).await?;
        Ok(owners.into_iter().map(Into::into).collect())
    }

    /// With `admin`, they are an admin of `assistant` too.
    pub async fn add_owner(
        &self,
        assistant: String,
        player_id: String,
        admin: bool,
    ) -> Result<ServerOwner, NudgeError> {
        let api = self.api.clone();
        Ok(
            run(async move { api.add_owner(&assistant, &player_id, admin).await })
                .await?
                .into(),
        )
    }

    /// Invites `address` to an assistant here through its federation: the join link, for an
    /// owner joining it from home.
    pub async fn invite(&self, assistant: String, address: String) -> Result<String, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.invite(&assistant, &address).await }).await?)
    }

    pub async fn remove_owner(&self, id: String) -> Result<(), NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.remove_owner(&id).await }).await?)
    }

    pub async fn check_updates(&self) -> Result<UpdateState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.check_updates().await }).await?.into())
    }

    pub async fn set_updates(&self, automatic: bool) -> Result<UpdateState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.set_updates(automatic).await })
            .await?
            .into())
    }

    /// The server's own Tailscale; fails with 404 where it can't run.
    pub async fn tailscale(&self) -> Result<TailscaleState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.tailscale().await }).await?.into())
    }

    /// Joins the server to a tailnet: at once with `auth_key`, else open the state's `auth_url`
    /// and ask `tailscale()` until it is connected.
    pub async fn connect_tailscale(
        &self,
        auth_key: Option<String>,
    ) -> Result<TailscaleState, NudgeError> {
        let api = self.api.clone();
        Ok(
            run(async move { api.connect_tailscale(auth_key.as_deref()).await })
                .await?
                .into(),
        )
    }

    pub async fn disconnect_tailscale(&self) -> Result<TailscaleState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.disconnect_tailscale().await })
            .await?
            .into())
    }

    /// The server's Wired; fails with 404 on a server that wasn't given one.
    pub async fn wired(&self) -> Result<WiredState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.wired().await }).await?.into())
    }

    /// Takes the server out of Wired: it leaves the network, or stops holding it.
    pub async fn disable_wired(&self) -> Result<WiredState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.disable_wired().await }).await?.into())
    }

    /// On the server that holds the network: removes the server called `name` from it, as when
    /// that server was deleted, so a new one can take the name.
    pub async fn remove_wired_member(&self, name: String) -> Result<WiredState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.remove_wired_member(&name).await })
            .await?
            .into())
    }

    /// Makes the server the root of its own Wired network, as a home server is.
    pub async fn enable_wired(&self) -> Result<WiredState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.enable_wired().await }).await?.into())
    }

    /// On the root: lists the relay another server will serve at `url`, its public HTTPS address,
    /// and answers with the invite it joins with (`join_wired` there). The invite is a credential.
    pub async fn add_wired_relay(&self, url: String) -> Result<String, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.add_wired_relay(&url).await }).await?)
    }

    /// Joins the network `invite` is for, serving a relay at the server's public HTTPS address.
    pub async fn join_wired(&self, invite: String) -> Result<WiredState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.join_wired(&invite, None).await })
            .await?
            .into())
    }

    /// Puts `other`, a server with a public HTTPS address, in this server's Wired network: this
    /// one (the root) lists `other`'s relay, and `other` joins with the invite. The invite never
    /// leaves this call.
    pub async fn connect_wired(
        &self,
        other: Arc<ServerClient>,
        other_url: String,
    ) -> Result<WiredState, NudgeError> {
        let (home, other) = (self.api.clone(), other.api.clone());
        Ok(run(async move {
            let invite = home.add_wired_relay(&other_url).await?;
            other.join_wired(&invite, None).await
        })
        .await?
        .into())
    }

    /// The recovery kit as the text of a file to save away from the server.
    pub async fn recovery_kit(&self, passphrase: String) -> Result<String, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.recovery_kit(&passphrase).await }).await?)
    }
}

/// Whether `server` waits to be set up, and what it offers; needs no token.
/// Who can reach a server at its address, as another server would.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Reach {
    /// Anyone.
    Public,
    /// Only the same tailnet: another server needs its own Tailscale connected.
    Tailnet,
    /// Only the same Wired network (`nudge.<name>.wired`): another server has to join it.
    Wired,
    /// Only the same network, such as a LAN address: no other server.
    Private,
}

/// Who can reach `server` at that address.
#[uniffi::export]
pub fn reach(server: String) -> Reach {
    match nudge_client::reach(&server) {
        nudge_client::Reach::Public => Reach::Public,
        nudge_client::Reach::Tailnet => Reach::Tailnet,
        nudge_client::Reach::Wired => Reach::Wired,
        nudge_client::Reach::Private => Reach::Private,
    }
}

#[uniffi::export]
pub async fn setup_info(server: String) -> Result<SetupInfo, NudgeError> {
    let info = run(async move { nudge_client::setup_info(&server).await }).await?;
    Ok(SetupInfo {
        open: info.open,
        providers: info
            .providers
            .into_iter()
            .map(|provider| SetupProvider {
                id: provider.id,
                name: provider.name,
                models: provider
                    .models
                    .into_iter()
                    .map(|model| SetupModel {
                        id: model.id,
                        name: model.name,
                    })
                    .collect(),
                recommended: provider.recommended,
            })
            .collect(),
        local: info
            .local
            .into_iter()
            .map(|server| SetupLocalServer {
                id: server.id,
                name: server.name,
                base_url: server.base_url,
                models: server.models,
            })
            .collect(),
    })
}

/// Whether `code` is the setup code: 401 when it isn't, which counts against a few tries.
#[uniffi::export]
pub async fn check_setup_code(server: String, code: String) -> Result<(), NudgeError> {
    Ok(run(async move { nudge_client::check_setup_code(&server, &code).await }).await?)
}

/// Tries a provider's key with one tiny request: 400 with the provider's answer when it fails.
#[uniffi::export]
pub async fn check_setup_key(
    server: String,
    code: String,
    provider: String,
    key: String,
) -> Result<(), NudgeError> {
    let body = p::SetupKeyRequest {
        code,
        provider,
        key,
    };
    Ok(run(async move { nudge_client::check_setup_key(&server, &body).await }).await?)
}

/// Sets the server up. Keep `token` as the player's on the new assistant, and `server_token` as
/// the owner's for `ServerClient`.
#[uniffi::export]
pub async fn set_up(
    server: String,
    choices: SetupChoices,
    client_name: String,
    platform: String,
) -> Result<SetupResult, NudgeError> {
    let body = p::SetupRequest {
        code: choices.code,
        client: client_info(&client_name, &platform),
        assistant: p::SetupAssistant {
            name: choices.assistant_name,
            display_name: choices.display_name,
        },
        model: choices.model.into(),
        key: choices.key,
        local: choices.local,
        you: p::SetupPerson {
            display_name: choices.your_name,
        },
        public_url: choices.public_url,
        backups: Some(choices.backups),
    };
    let done = run(async move { nudge_client::set_up(&server, &body).await }).await?;
    Ok(SetupResult {
        assistant: done.assistant,
        player: done.player.into(),
        token: done.token,
        client_id: done.client_id,
        server_token: done.server_token,
        owner: done.owner.into(),
    })
}

/// exe.dev with the person's API token, which the app keeps in its keychain and never sends to a
/// Nudge server.
#[derive(uniffi::Object)]
pub struct ExeClient {
    exe: nudge_client::ExeDev,
}

#[uniffi::export]
impl ExeClient {
    #[uniffi::constructor]
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(ExeClient {
            exe: nudge_client::ExeDev::new(&token),
        })
    }

    /// Checks the token: what exe.dev says about whose it is, as JSON.
    pub async fn whoami(&self) -> Result<String, NudgeError> {
        let exe = self.exe.clone();
        Ok(run(async move { exe.whoami().await }).await?.to_string())
    }

    pub async fn list(&self) -> Result<Vec<ExeVm>, NudgeError> {
        let exe = self.exe.clone();
        let vms = run(async move { exe.list().await }).await?;
        Ok(vms
            .into_iter()
            .map(|vm| ExeVm {
                name: vm.name,
                url: vm.url,
            })
            .collect())
    }

    /// Makes a VM named `name` running Nudge, and waits up to `wait_seconds` until it can be set
    /// up with the returned code.
    pub async fn launch_server(
        &self,
        name: String,
        wait_seconds: u32,
    ) -> Result<LaunchedServer, NudgeError> {
        let exe = self.exe.clone();
        let wait = Duration::from_secs(wait_seconds.into());
        let launched = run(async move { exe.launch_server(&name, wait).await }).await?;
        Ok(LaunchedServer {
            vm: ExeVm {
                name: launched.vm.name,
                url: launched.vm.url,
            },
            code: launched.code,
        })
    }

    /// Like `launch_server`, and the new server joins `home`'s Wired network as it starts: home
    /// lists the relay it will serve at its exe.dev address, and passes it the invite. `home`
    /// must hold the network (`enable_wired`).
    pub async fn launch_wired_server(
        &self,
        name: String,
        wait_seconds: u32,
        home: Arc<ServerClient>,
    ) -> Result<LaunchedServer, NudgeError> {
        let exe = self.exe.clone();
        let wait = Duration::from_secs(wait_seconds.into());
        let home = home.api.clone();
        let launched =
            run(async move { exe.launch_wired_server(&name, wait, &home).await }).await?;
        Ok(LaunchedServer {
            vm: ExeVm {
                name: launched.vm.name,
                url: launched.vm.url,
            },
            code: launched.code,
        })
    }

    /// Removes the VM and everything on it.
    pub async fn delete(&self, name: String) -> Result<(), NudgeError> {
        let exe = self.exe.clone();
        Ok(run(async move { exe.delete(&name).await }).await?)
    }
}

/// The command a person runs once to give the app an exe.dev token: limited to what making and
/// removing Nudge servers needs, for a year.
#[uniffi::export]
pub fn exe_token_command() -> String {
    "ssh exe.dev ssh-key generate-api-key --exp=365d --cmds=whoami,ls,new,rm,share".to_owned()
}

/// Makes the app's SSH key for exe.dev, once; signing in adds it to the person's account.
#[uniffi::export]
pub fn exe_new_key() -> Result<ExeKey, NudgeError> {
    let key = nudge_client::new_exe_key()?;
    Ok(ExeKey {
        private_key: key.private_key,
        public_key: key.public_key,
    })
}

/// An exe.dev token signed with the app's key, for `ExeClient`, good for `days`. It works once
/// the key is on the person's account, as `ExeLogin` puts it there.
#[uniffi::export]
pub fn exe_mint_token(private_key: String, days: u32) -> Result<String, NudgeError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(nudge_client::mint_exe_token(
        &private_key,
        Some(now + u64::from(days) * 86_400),
    )?)
}

/// Hears an exe.dev sign-in, on one of the library's threads.
#[uniffi::export(with_foreign)]
pub trait ExeLoginListener: Send + Sync {
    /// The terminal's screen as text, a line per row.
    fn on_screen(&self, text: String);
    /// exe.dev ended the session, or it failed with `problem`.
    fn on_closed(&self, problem: Option<String>);
}

struct ForeignExeScreen(Arc<dyn ExeLoginListener>);

impl nudge_client::ExeScreen for ForeignExeScreen {
    fn screen(&self, text: String) {
        self.0.on_screen(text);
    }

    fn closed(&self, problem: Option<String>) {
        self.0.on_closed(problem);
    }
}

/// `ssh exe.dev` with the app's key, for the person to sign up or sign in: exe.dev asks for their
/// email and sends a link, which adds the key to their account. Show its screen, send what they
/// type. Ending it, or dropping it, ends the session.
#[derive(uniffi::Object)]
pub struct ExeLogin {
    login: std::sync::Mutex<Option<nudge_client::ExeLogin>>,
}

#[uniffi::export]
impl ExeLogin {
    /// Connects to exe.dev, checking its host key, with a terminal of `cols` × `rows`.
    #[uniffi::constructor]
    pub async fn start(
        private_key: String,
        cols: u16,
        rows: u16,
        listener: Arc<dyn ExeLoginListener>,
    ) -> Result<Arc<Self>, NudgeError> {
        let screen = Arc::new(ForeignExeScreen(listener));
        let login = run(async move {
            nudge_client::ExeLogin::start(&private_key, cols, rows, screen).await
        })
        .await?;
        Ok(Arc::new(ExeLogin {
            login: std::sync::Mutex::new(Some(login)),
        }))
    }

    /// Types `text`, as is; a line ends with `\r`.
    pub fn send(&self, text: String) {
        if let Some(login) = self.login.lock().unwrap().as_ref() {
            login.send(&text);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(login) = self.login.lock().unwrap().as_ref() {
            login.resize(cols, rows);
        }
    }

    /// Ends the session; named so, as Kotlin's objects have a `close()` of their own.
    pub fn end(&self) {
        self.login.lock().unwrap().take();
    }
}
