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

/// Monthly limits on model spend, in US dollars; `warn_at` is a share between 0 and 1, and
/// `warn_usd`, without `monthly_usd`, the spend at which admins hear there is no limit. Saving
/// settings sends the budget whole, so it keeps every field as the server gave it.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AssistantBudget {
    pub monthly_usd: Option<f64>,
    pub per_player_usd: Option<f64>,
    pub warn_at: Option<f64>,
    #[uniffi(default = None)]
    pub warn_usd: Option<f64>,
}

/// How much an assistant says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AssistantStyle {
    Concise,
    Balanced,
    Detailed,
}

/// How much an assistant decides itself before asking; approvals apply at every level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AssistantAutonomy {
    Cautious,
    Balanced,
    Independent,
}

/// An assistant's settings, as the owner edits them; saved whole. A missing style or autonomy
/// is the server's default (concise, balanced).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AssistantSettings {
    pub display_name: String,
    pub model: ModelChoice,
    pub time_zone: Option<String>,
    pub instructions: Option<String>,
    pub budget: Option<AssistantBudget>,
    #[uniffi(default = None)]
    pub style: Option<AssistantStyle>,
    #[uniffi(default = None)]
    pub autonomy: Option<AssistantAutonomy>,
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
    /// For someone who lives on one of the server's assistants: it, and their id there.
    pub assistant: Option<String>,
    pub player_id: Option<String>,
    /// For someone whose home is elsewhere, which vouches for them: their address.
    pub address: Option<String>,
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

/// Where backups are copied off the server (ADR 8).
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum BackupTarget {
    /// An S3-compatible bucket: AWS, B2, R2, MinIO. `region` defaults to the one in an AWS
    /// endpoint, else us-east-1; `path_style` (bucket in the path) defaults on, except for AWS.
    S3 {
        endpoint: String,
        bucket: String,
        region: Option<String>,
        prefix: Option<String>,
        path_style: Option<bool>,
    },
    /// A WebDAV folder, such as `https://cloud.example/remote.php/dav/files/me/nudge/`.
    WebDav { url: String },
}

/// The server's backups: where, how often, how many, and how the last upload went.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct BackupState {
    /// Whether the server makes backups on its own; the rest is its defaults when it doesn't.
    pub on: bool,
    /// The folder on the server they go to.
    pub dir: Option<String>,
    pub every_hours: f64,
    /// Backups kept, in the folder and on the remote alike.
    pub keep: u32,
    pub last_backup_at: Option<f64>,
    pub remote: Option<BackupTarget>,
    /// The access key id or user name the remote is reached with.
    pub remote_user: Option<String>,
    /// Whether that is set in the server's environment, so the apps can't change it.
    pub remote_user_from_env: bool,
    pub last_upload_at: Option<f64>,
    /// Why the last upload failed, when it did, and when.
    pub last_error: Option<String>,
    pub last_error_at: Option<f64>,
}

/// A backup made now: its file name, and why the upload failed if it did.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct BackupMade {
    pub file: String,
    pub upload_error: Option<String>,
}

/// How far the server's map is (ADR 18).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GeoState {
    Off,
    Working,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GeoRegionState {
    Waiting,
    Downloading,
    Importing,
    Ready,
    Failed,
}

/// One region of the server's map.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct GeoRegionStatus {
    pub id: String,
    pub name: String,
    /// Picked by an owner; false for one fetched because someone was there.
    pub by_owner: bool,
    pub state: GeoRegionState,
    pub step: Option<String>,
    /// Of the current download, from 0 to 1.
    pub progress: Option<f64>,
    pub bytes: Option<f64>,
    pub updated_at: Option<f64>,
    pub used_at: Option<f64>,
    pub error: Option<String>,
}

/// The server's own map, for regions anywhere in the world: those owners pick, and those people's
/// phones say they are in when `follow` is on, within `limit_gb`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct GeoStatus {
    pub state: GeoState,
    pub follow: bool,
    pub limit_gb: f64,
    pub used_bytes: f64,
    pub regions: Vec<GeoRegionStatus>,
    pub error: Option<String>,
}

/// A region the map can hold, such as `norway` or `us/california` in `north-america`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct GeoRegion {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
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
    /// Federation for its assistant, so it can be part of the person's cluster; false sets it up
    /// standalone.
    pub federation: bool,
    /// An owner assertion from the person's home, from `NudgeClient::owner_assertion` with this
    /// server, when they are signed in there: its first player is them, so it can join their
    /// cluster later. `None` makes them a new home there.
    pub home_assertion: Option<String>,
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
            warn_usd: b.warn_usd,
        }
    }
}

impl From<AssistantBudget> for p::AssistantBudget {
    fn from(b: AssistantBudget) -> Self {
        p::AssistantBudget {
            monthly_usd: b.monthly_usd,
            per_player_usd: b.per_player_usd,
            warn_at: b.warn_at,
            warn_usd: b.warn_usd,
        }
    }
}

impl From<p::AssistantStyle> for AssistantStyle {
    fn from(s: p::AssistantStyle) -> Self {
        match s {
            p::AssistantStyle::Concise => AssistantStyle::Concise,
            p::AssistantStyle::Balanced => AssistantStyle::Balanced,
            p::AssistantStyle::Detailed => AssistantStyle::Detailed,
        }
    }
}

impl From<AssistantStyle> for p::AssistantStyle {
    fn from(s: AssistantStyle) -> Self {
        match s {
            AssistantStyle::Concise => p::AssistantStyle::Concise,
            AssistantStyle::Balanced => p::AssistantStyle::Balanced,
            AssistantStyle::Detailed => p::AssistantStyle::Detailed,
        }
    }
}

impl From<p::AssistantAutonomy> for AssistantAutonomy {
    fn from(a: p::AssistantAutonomy) -> Self {
        match a {
            p::AssistantAutonomy::Cautious => AssistantAutonomy::Cautious,
            p::AssistantAutonomy::Balanced => AssistantAutonomy::Balanced,
            p::AssistantAutonomy::Independent => AssistantAutonomy::Independent,
        }
    }
}

impl From<AssistantAutonomy> for p::AssistantAutonomy {
    fn from(a: AssistantAutonomy) -> Self {
        match a {
            AssistantAutonomy::Cautious => p::AssistantAutonomy::Cautious,
            AssistantAutonomy::Balanced => p::AssistantAutonomy::Balanced,
            AssistantAutonomy::Independent => p::AssistantAutonomy::Independent,
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
                style: a.style.map(Into::into),
                autonomy: a.autonomy.map(Into::into),
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
            address: o.address,
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

impl From<p::BackupRemoteTarget> for BackupTarget {
    fn from(t: p::BackupRemoteTarget) -> Self {
        match t {
            p::BackupRemoteTarget::S3(s3) => BackupTarget::S3 {
                endpoint: s3.endpoint,
                bucket: s3.bucket,
                region: s3.region,
                prefix: s3.prefix,
                path_style: s3.path_style,
            },
            p::BackupRemoteTarget::Webdav(dav) => BackupTarget::WebDav { url: dav.url },
        }
    }
}

impl From<BackupTarget> for p::BackupRemoteTarget {
    fn from(t: BackupTarget) -> Self {
        match t {
            BackupTarget::S3 {
                endpoint,
                bucket,
                region,
                prefix,
                path_style,
            } => p::BackupRemoteTarget::S3(p::S3Target {
                endpoint,
                bucket,
                region,
                prefix,
                path_style,
            }),
            BackupTarget::WebDav { url } => p::BackupRemoteTarget::Webdav(p::WebDavTarget { url }),
        }
    }
}

impl From<p::BackupState> for BackupState {
    fn from(b: p::BackupState) -> Self {
        BackupState {
            on: b.on,
            dir: b.dir,
            every_hours: b.every_hours,
            keep: b.keep as u32,
            last_backup_at: b.last_backup_at,
            remote: b.remote.map(Into::into),
            remote_user_from_env: matches!(
                b.credentials,
                Some(p::BackupCredentials {
                    from: p::CredentialsFrom::Env,
                    ..
                })
            ),
            remote_user: b.credentials.map(|c| c.user),
            last_upload_at: b.last_upload_at,
            last_error: b.last_error,
            last_error_at: b.last_error_at,
        }
    }
}

impl From<p::GeoStatus> for GeoStatus {
    fn from(g: p::GeoStatus) -> Self {
        GeoStatus {
            state: match g.state {
                p::GeoState::Off => GeoState::Off,
                p::GeoState::Working => GeoState::Working,
                p::GeoState::Ready => GeoState::Ready,
                p::GeoState::Failed => GeoState::Failed,
            },
            follow: g.follow,
            limit_gb: g.limit_gb,
            used_bytes: g.used_bytes,
            regions: g
                .regions
                .into_iter()
                .map(|r| GeoRegionStatus {
                    id: r.id,
                    name: r.name,
                    by_owner: r.by == p::GeoRegionBy::Owner,
                    state: match r.state {
                        p::GeoRegionState::Waiting => GeoRegionState::Waiting,
                        p::GeoRegionState::Downloading => GeoRegionState::Downloading,
                        p::GeoRegionState::Importing => GeoRegionState::Importing,
                        p::GeoRegionState::Ready => GeoRegionState::Ready,
                        p::GeoRegionState::Failed => GeoRegionState::Failed,
                    },
                    step: r.step,
                    progress: r.progress,
                    bytes: r.bytes,
                    updated_at: r.updated_at,
                    used_at: r.used_at,
                    error: r.error,
                })
                .collect(),
            error: g.error,
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

    /// Trades an assertion from the owner's home, from `NudgeClient::owner_assertion`, for a server
    /// token, and stores it: for an owner whose home is elsewhere.
    pub async fn sign_in_from_home(&self, assertion: String) -> Result<ServerOwner, NudgeError> {
        let assertion: p::Sealed =
            serde_json::from_str(&assertion).map_err(|error| NudgeError::Decode {
                detail: format!("Not an assertion: {error}"),
            })?;
        let (api, info) = (self.api.clone(), self.info.clone());
        let session = run(async move { api.sign_in_from_home(assertion, info).await }).await?;
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
            style: settings.style.map(Into::into),
            autonomy: settings.autonomy.map(Into::into),
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
            style: Some(settings.style.map(Into::into)),
            autonomy: Some(settings.autonomy.map(Into::into)),
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

    /// Makes the person at `address` an owner too, vouched for by their home when they sign in.
    pub async fn add_owner_at(&self, address: String) -> Result<ServerOwner, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.add_owner_at(&address).await })
            .await?
            .into())
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

    /// The server's own map; fails with 404 on a server that wasn't given one.
    pub async fn geo(&self) -> Result<GeoStatus, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.geo().await }).await?.into())
    }

    /// Changes what the map holds: `regions`, when given, is the whole list owners want (ids
    /// from `geo_regions`); `follow` and `limit_gb` change when given.
    pub async fn configure_geo(
        &self,
        regions: Option<Vec<String>>,
        follow: Option<bool>,
        limit_gb: Option<f64>,
    ) -> Result<GeoStatus, NudgeError> {
        let api = self.api.clone();
        let change = p::SetGeoRequest {
            regions,
            follow,
            limit_gb,
        };
        Ok(run(async move { api.configure_geo(&change).await })
            .await?
            .into())
    }

    /// Every region the map can hold, anywhere in the world.
    pub async fn geo_regions(&self) -> Result<Vec<GeoRegion>, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.geo_regions().await })
            .await?
            .into_iter()
            .map(|r| GeoRegion {
                id: r.id,
                name: r.name,
                parent: r.parent,
            })
            .collect())
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

    /// Makes the server the root of its own Wired network, as a home server is, as `name` (such
    /// as `box`) when given; else as its public address's first label, or its host's name.
    #[uniffi::method(default(name = None))]
    pub async fn enable_wired(&self, name: Option<String>) -> Result<WiredState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.enable_wired(name.as_deref()).await })
            .await?
            .into())
    }

    /// On the root: lists the relay another server will serve at `url`, its public HTTPS address,
    /// and answers with the invite it joins with (`join_wired` there). The invite is a credential.
    pub async fn add_wired_relay(&self, url: String) -> Result<String, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.add_wired_relay(&url).await }).await?)
    }

    /// Joins the network `invite` is for, as `name` when given, serving a relay at the server's
    /// public HTTPS address.
    #[uniffi::method(default(name = None))]
    pub async fn join_wired(
        &self,
        invite: String,
        name: Option<String>,
    ) -> Result<WiredState, NudgeError> {
        let api = self.api.clone();
        Ok(
            run(async move { api.join_wired(&invite, None, name.as_deref()).await })
                .await?
                .into(),
        )
    }

    /// Puts `other`, a server with a public HTTPS address, in this server's Wired network: this
    /// one (the root) lists `other`'s relay, and `other` joins with the invite, as `name` when
    /// given. The invite never leaves this call.
    #[uniffi::method(default(name = None))]
    pub async fn connect_wired(
        &self,
        other: Arc<ServerClient>,
        other_url: String,
        name: Option<String>,
    ) -> Result<WiredState, NudgeError> {
        let (home, other) = (self.api.clone(), other.api.clone());
        Ok(run(async move {
            let invite = home.add_wired_relay(&other_url).await?;
            other.join_wired(&invite, None, name.as_deref()).await
        })
        .await?
        .into())
    }

    /// The recovery kit as the text of a file to save away from the server.
    pub async fn recovery_kit(&self, passphrase: String) -> Result<String, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.recovery_kit(&passphrase).await }).await?)
    }

    /// The server's backups; fails with 404 on a server that doesn't make them through its API.
    pub async fn backups(&self) -> Result<BackupState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.backups().await }).await?.into())
    }

    /// Makes a backup now, and uploads it where backups are copied.
    pub async fn back_up_now(&self) -> Result<BackupMade, NudgeError> {
        let api = self.api.clone();
        let made = run(async move { api.back_up_now().await }).await?;
        Ok(BackupMade {
            file: made.file,
            upload_error: made.upload_error,
        })
    }

    /// Copies every backup to `target` too, signed in with `user` and `secret` (an access key
    /// id and secret for S3, a user name and password for WebDAV); without them the kept ones
    /// stay. The server first writes, lists and deletes a small file there; a 400 says why that
    /// failed.
    pub async fn set_backup_remote(
        &self,
        target: BackupTarget,
        user: Option<String>,
        secret: Option<String>,
    ) -> Result<BackupState, NudgeError> {
        let body = p::SetBackupRemoteRequest {
            target: target.into(),
            user,
            secret,
            test: None,
        };
        let api = self.api.clone();
        Ok(run(async move { api.set_backup_remote(&body).await })
            .await?
            .into())
    }

    /// Keeps backups on the server only, and forgets the remote's credentials.
    pub async fn remove_backup_remote(&self) -> Result<BackupState, NudgeError> {
        let api = self.api.clone();
        Ok(run(async move { api.remove_backup_remote().await })
            .await?
            .into())
    }
}

/// Whether `server` waits to be set up, and what it offers; needs no token.
/// Who can reach a server at its address, as another server would.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Reach {
    /// Anyone.
    Public,
    /// Only the same Wired network (`nudge.<name>.wired`): another server has to join it.
    Wired,
    /// Only the same network, such as a LAN or tailnet address: no other server.
    Private,
}

/// Who can reach `server` at that address.
#[uniffi::export]
pub fn reach(server: String) -> Reach {
    match nudge_client::reach(&server) {
        nudge_client::Reach::Public => Reach::Public,
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
    let home = match choices.home_assertion {
        None => None,
        Some(assertion) => Some(serde_json::from_str::<p::Sealed>(&assertion).map_err(
            |error| NudgeError::Decode {
                detail: format!("Not an assertion: {error}"),
            },
        )?),
    };
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
        federation: Some(choices.federation),
        home,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_every_budget_field_through_the_apps_settings() {
        // The apps save settings whole: a budget the server gave must go back as it came.
        let given: p::AssistantBudget =
            serde_json::from_str(r#"{"perPlayerUsd":5,"warnAt":0.5,"warnUsd":40,"later":true}"#)
                .unwrap();
        let edited: AssistantBudget = given.clone().into();
        assert_eq!(edited.warn_usd, Some(40.0));
        let saved: p::AssistantBudget = edited.into();
        assert_eq!(saved, given);
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::json!({ "perPlayerUsd": 5.0, "warnAt": 0.5, "warnUsd": 40.0 })
        );
    }

    #[test]
    fn tells_a_spent_budget_and_a_rate_limit_as_429s() {
        let spent: NudgeError =
            nudge_client::ApiError::BudgetSpent("You have used your budget.".into()).into();
        assert_eq!(spent.to_string(), "You have used your budget. (429)");
        let limited: NudgeError = nudge_client::ApiError::RateLimited {
            message: "Too many requests; try again in 3 s".into(),
            retry_after: Some(3),
        }
        .into();
        assert_eq!(
            limited.to_string(),
            "Too many requests; try again in 3 s (429)"
        );
    }
}
