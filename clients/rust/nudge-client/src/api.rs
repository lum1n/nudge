use std::sync::{Arc, Mutex};

use nudge_protocol::*;
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use url::Url;

/// Where a client keeps its token: in memory, a keychain, a file. `Api::pair` stores the token it
/// gets, and every request reads it again, so a token set elsewhere is picked up.
pub trait TokenStore: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, token: Option<String>);
}

/// A token kept in memory only.
#[derive(Default)]
pub struct MemoryTokens(Mutex<Option<String>>);

impl MemoryTokens {
    pub fn new(token: Option<String>) -> Self {
        MemoryTokens(Mutex::new(token))
    }
}

impl TokenStore for MemoryTokens {
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    fn set(&self, token: Option<String>) {
        *self.0.lock().unwrap() = token;
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// A non-2xx answer: 400 bad body, 401 no or unknown token, 403 not an admin, 404, 409.
    #[error("{message} ({status})")]
    Status { status: u16, message: String },
    /// A 429 for asking too often: the same request works again after `retry_after` seconds,
    /// when the server said.
    #[error("{message}")]
    RateLimited {
        message: String,
        retry_after: Option<u64>,
    },
    /// A 429 for a message once the caller's or the assistant's monthly budget is spent; sending
    /// it again won't help until the month ends or the budget changes.
    #[error("{0}")]
    BudgetSpent(String),
    /// No answer: the server is down or the network is gone.
    #[error("{0}")]
    Network(String),
    /// An answer this client couldn't read.
    #[error("Unreadable answer: {0}")]
    Decode(String),
    #[error("Not a server address: {0}")]
    Address(String),
}

impl ApiError {
    /// Whether the same request may work later: no answer, the server failed (5xx), or it was
    /// rate limited. Messages are safe to send again, since the server answers a repeated
    /// `requestId` with the same submission.
    pub fn is_retryable(&self) -> bool {
        match self {
            ApiError::Network(_) | ApiError::RateLimited { .. } => true,
            ApiError::Status { status, .. } => *status >= 500,
            _ => false,
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            ApiError::Status { status, .. } => Some(*status),
            ApiError::RateLimited { .. } | ApiError::BudgetSpent(_) => Some(429),
            _ => None,
        }
    }
}

/// A page of a room's history: older than the room view's window, or than `before`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PageRequest {
    pub before: Option<String>,
    pub limit: Option<u32>,
}

/// Protocol v1's HTTP commands for one assistant, signed in with the token in `tokens`.
#[derive(Clone)]
pub struct Api {
    base: Url,
    tokens: Arc<dyn TokenStore>,
    http: reqwest::Client,
}

/// The assistants `server` hosts; needs no token.
pub async fn list_assistants(server: &str) -> Result<AssistantsResponse, ApiError> {
    let url = endpoint(&parse_server(server)?, &["v1", "a"]);
    read(reqwest::Client::new().get(url).send().await).await
}

/// Registers a device with a push relay (`packages/relay`) and returns its handle, which servers
/// push to it through. `platform` and `environment` are as for `Api::register_device`.
pub async fn register_with_relay(
    relay: &str,
    platform: DevicePlatform,
    token: &str,
    environment: Option<PushEnvironment>,
) -> Result<String, ApiError> {
    #[derive(serde::Deserialize)]
    struct Registered {
        handle: String,
    }
    let url = endpoint(&parse_server(relay)?, &["v1", "register"]);
    let device = NativeDevice {
        platform,
        token: token.to_owned(),
        environment,
        account: None,
    };
    let registered: Registered =
        read(reqwest::Client::new().post(url).json(&device).send().await).await?;
    Ok(registered.handle)
}

impl Api {
    /// `server` is the server's address, such as `https://nudge.example`.
    pub fn new(
        server: &str,
        assistant: &str,
        tokens: Arc<dyn TokenStore>,
    ) -> Result<Self, ApiError> {
        Ok(Api {
            base: endpoint(&parse_server(server)?, &["v1", "a", assistant]),
            tokens,
            http: reqwest::Client::new(),
        })
    }

    pub fn tokens(&self) -> &Arc<dyn TokenStore> {
        &self.tokens
    }

    /// Trades a pairing code for a token, and stores it.
    pub async fn pair(&self, code: &str, client: ClientInfo) -> Result<PairResponse, ApiError> {
        let body = PairRequest {
            code: code.to_owned(),
            client,
        };
        let paired: PairResponse = self
            .request(Method::POST, &["pair"], &[], Some(&body))
            .await?;
        self.tokens.set(Some(paired.token.clone()));
        Ok(paired)
    }

    pub async fn me(&self) -> Result<MeResponse, ApiError> {
        self.request(Method::GET, &["me"], &[], NO_BODY).await
    }

    /// Signs in the browser whose QR code holds sign-in `id`, as the caller.
    pub async fn approve_sign_in(&self, id: &str) -> Result<(), ApiError> {
        self.request_empty(Method::POST, &["sign-in", id], &[], NO_BODY)
            .await
    }

    /// Revokes this client's own token, and forgets it.
    pub async fn sign_out(&self) -> Result<(), ApiError> {
        self.request_empty(Method::DELETE, &["me", "token"], &[], NO_BODY)
            .await?;
        self.tokens.set(None);
        Ok(())
    }

    pub async fn create_room(&self, body: &CreateRoomRequest) -> Result<Room, ApiError> {
        self.request(Method::POST, &["rooms"], &[], Some(body))
            .await
    }

    /// The room keeps its id. Its owner or members may rename it, admins any room, the lobby too.
    pub async fn rename_room(&self, room: &str, name: &str) -> Result<Room, ApiError> {
        let body = RenameRoomRequest {
            name: name.to_owned(),
        };
        self.request(Method::PATCH, &["rooms", room], &[], Some(&body))
            .await
    }

    /// The caller's personal room, made on first use.
    pub async fn personal_room(&self) -> Result<Room, ApiError> {
        self.request(Method::POST, &["rooms", "personal"], &[], NO_BODY)
            .await
    }

    /// Posts a message. Sending the same `request_id` again is answered with the same submission.
    pub async fn send(
        &self,
        room: &str,
        body: &MessageRequest,
    ) -> Result<MessageResponse, ApiError> {
        self.request(Method::POST, &["rooms", room, "messages"], &[], Some(body))
            .await
    }

    /// Stops the answer in progress, and drops the room's queued messages.
    pub async fn abort(&self, room: &str) -> Result<(), ApiError> {
        self.request_empty(Method::POST, &["rooms", room, "abort"], &[], NO_BODY)
            .await
    }

    /// Items older than the room view's, or than `before` from an earlier page; oldest first.
    pub async fn timeline(
        &self,
        room: &str,
        page: &PageRequest,
    ) -> Result<TimelineResponse, ApiError> {
        let limit = page.limit.map(|limit| limit.to_string());
        let mut query = Vec::new();
        if let Some(before) = &page.before {
            query.push(("before", before.as_str()));
        }
        if let Some(limit) = &limit {
            query.push(("limit", limit.as_str()));
        }
        self.request(Method::GET, &["rooms", room, "timeline"], &query, NO_BODY)
            .await
    }

    pub async fn remember(&self, room: &str, text: &str) -> Result<Fact, ApiError> {
        let body = RememberRequest {
            text: text.to_owned(),
        };
        self.request(Method::POST, &["rooms", room, "memory"], &[], Some(&body))
            .await
    }

    pub async fn forget(&self, room: &str, fact: &str) -> Result<(), ApiError> {
        self.request_empty(
            Method::DELETE,
            &["rooms", room, "memory", fact],
            &[],
            NO_BODY,
        )
        .await
    }

    /// The caller's own memory, and whether they share it with all their rooms.
    pub async fn my_memory(&self) -> Result<PlayerMemoryResponse, ApiError> {
        self.request(Method::GET, &["me", "memory"], &[], NO_BODY)
            .await
    }

    pub async fn remember_for_me(&self, text: &str) -> Result<Fact, ApiError> {
        let body = RememberRequest {
            text: text.to_owned(),
        };
        self.request(Method::POST, &["me", "memory"], &[], Some(&body))
            .await
    }

    pub async fn forget_for_me(&self, fact: &str) -> Result<(), ApiError> {
        self.request_empty(Method::DELETE, &["me", "memory", fact], &[], NO_BODY)
            .await
    }

    /// With `shared`, everyone in the caller's rooms, and the model there, sees their own facts.
    pub async fn share_my_memory(&self, shared: bool) -> Result<PlayerMemoryResponse, ApiError> {
        let body = ShareMemoryRequest { shared };
        self.request(Method::PUT, &["me", "memory", "sharing"], &[], Some(&body))
            .await
    }

    pub async fn room_extensions(&self, room: &str) -> Result<Vec<RoomExtension>, ApiError> {
        let response: RoomExtensionsResponse = self
            .request(Method::GET, &["rooms", room, "extensions"], &[], NO_BODY)
            .await?;
        Ok(response.extensions)
    }

    /// Turns an extension on or off in the room; `None` goes back to the default for its kind.
    pub async fn set_room_extension(
        &self,
        room: &str,
        extension: &str,
        enabled: Option<bool>,
    ) -> Result<RoomExtension, ApiError> {
        let body = SetRoomExtensionRequest { enabled };
        self.request(
            Method::PUT,
            &["rooms", room, "extensions", extension],
            &[],
            Some(&body),
        )
        .await
    }

    pub async fn decide(
        &self,
        room: &str,
        approval: &str,
        approve: bool,
        inputs: Option<std::collections::HashMap<String, String>>,
    ) -> Result<Approval, ApiError> {
        // What's typed into an approval's inputs is only sent, with a yes.
        let body = DecideRequest {
            approve,
            inputs: inputs.filter(|_| approve),
        };
        self.request(
            Method::POST,
            &["rooms", room, "approvals", approval],
            &[],
            Some(&body),
        )
        .await
    }

    /// Presses `button` on the card tool call `call_id` showed (ADR 27), with the card's fields by
    /// name; the press reaches the room as this player's message.
    pub async fn press_card(
        &self,
        room: &str,
        call_id: &str,
        button: &str,
        values: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<MessageResponse, ApiError> {
        let body = UiPressRequest {
            button: button.into(),
            values,
            request_id: None,
        };
        self.request(
            Method::POST,
            &["rooms", room, "ui", call_id],
            &[],
            Some(&body),
        )
        .await
    }

    pub async fn cancel_nudge(&self, nudge: &str) -> Result<(), ApiError> {
        self.request_empty(Method::DELETE, &["nudges", nudge], &[], NO_BODY)
            .await
    }

    /// A placeholder that stands for `value` in what the model sees. `private` also hides it
    /// from everyone else, wherever it shows.
    pub async fn protect(
        &self,
        value: &str,
        kind: Option<&str>,
        private: bool,
    ) -> Result<String, ApiError> {
        let body = ProtectRequest {
            value: value.to_owned(),
            kind: kind.map(str::to_owned),
            private: private.then_some(true),
        };
        let response: ProtectResponse = self
            .request(Method::POST, &["protect"], &[], Some(&body))
            .await?;
        Ok(response.placeholder)
    }

    /// The values only this player sees.
    pub async fn private_values(&self) -> Result<Vec<PrivateValue>, ApiError> {
        let response: PrivateValuesResponse = self
            .request(Method::GET, &["me", "private"], &[], NO_BODY)
            .await?;
        Ok(response.values)
    }

    /// Drops a value for good: from now on everyone, the model included, sees only `placeholder`.
    pub async fn forget_value(&self, placeholder: &str) -> Result<(), ApiError> {
        self.request_empty(Method::DELETE, &["vault", placeholder], &[], NO_BODY)
            .await
    }

    /// What the model saw in the room, as it was sent: placeholders, not the values.
    pub async fn model_view(&self, room: &str) -> Result<ModelViewResponse, ApiError> {
        self.request(Method::GET, &["rooms", room, "model-view"], &[], NO_BODY)
            .await
    }

    /// This month's model spend; every month, room and player for admins.
    pub async fn usage(&self) -> Result<UsageResponse, ApiError> {
        self.request(Method::GET, &["usage"], &[], NO_BODY).await
    }

    /// Which native pushes the server sends; 404 when it sends none.
    pub async fn push_platforms(&self) -> Result<DevicesResponse, ApiError> {
        self.request(Method::GET, &["ext", "push", "devices"], &[], NO_BODY)
            .await
    }

    /// Has the server push to this device when one of the player's rooms has news and they don't
    /// have it open. Registering again with the same token replaces the old one. Without an
    /// `account`, it is `push_account()`, so pushes say which sign-in they are for.
    pub async fn register_device(&self, device: &DeviceRequest) -> Result<(), ApiError> {
        let mut device = device.clone();
        let account = match &mut device {
            DeviceRequest::Native(native) => &mut native.account,
            DeviceRequest::Relay(relay) => &mut relay.account,
        };
        account.get_or_insert_with(|| self.push_account());
        self.request_empty(
            Method::POST,
            &["ext", "push", "devices"],
            &[],
            Some(&device),
        )
        .await
    }

    /// What this client's pushes carry as `account`: the same for every client of this server and
    /// assistant, and different for any other, though their assistants share a name. A hash, so
    /// APNs and FCM don't learn the server's address from it.
    pub fn push_account(&self) -> String {
        use base64::Engine;
        use sha2::Digest;
        let digest = sha2::Sha256::digest(self.base.as_str().as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&digest[..16])
    }

    pub async fn unregister_device(&self, token: &str) -> Result<(), ApiError> {
        self.request_empty(
            Method::DELETE,
            &["ext", "push", "devices", token],
            &[],
            NO_BODY,
        )
        .await
    }

    /// The places the phone should watch for the caller's arrival reminders (ADR 18), around
    /// where it is when given; 404 when the assistant has no places extension.
    pub async fn arrival_regions(
        &self,
        at: Option<(f64, f64)>,
    ) -> Result<ArrivalRegionsResponse, ApiError> {
        let (lat, lon) = at
            .map(|(lat, lon)| (lat.to_string(), lon.to_string()))
            .unwrap_or_default();
        let query: &[(&str, &str)] = if at.is_some() {
            &[("lat", lat.as_str()), ("lon", lon.as_str())]
        } else {
            &[]
        };
        self.request(Method::GET, &["ext", "places", "regions"], query, NO_BODY)
            .await
    }

    /// Tells the server the phone got to or left a region from `arrival_regions`.
    pub async fn report_region_event(
        &self,
        region_id: &str,
        event: RegionEvent,
    ) -> Result<RegionEventResponse, ApiError> {
        let body = RegionEventRequest {
            region_id: region_id.to_owned(),
            event,
        };
        self.request(Method::POST, &["ext", "places", "events"], &[], Some(&body))
            .await
    }

    /// The caller's saved places and arrival reminders.
    pub async fn places(&self) -> Result<PlacesResponse, ApiError> {
        self.request(Method::GET, &["ext", "places", "places"], &[], NO_BODY)
            .await
    }

    /// Forgets a saved place, by its name, and the reminders for it.
    pub async fn forget_place(&self, name: &str) -> Result<(), ApiError> {
        self.request_empty(
            Method::DELETE,
            &["ext", "places", "places", name],
            &[],
            NO_BODY,
        )
        .await
    }

    pub async fn cancel_arrival_reminder(&self, id: &str) -> Result<(), ApiError> {
        self.request_empty(
            Method::DELETE,
            &["ext", "places", "reminders", id],
            &[],
            NO_BODY,
        )
        .await
    }

    /// The caller's full name, e-mail, phone, address and location; only they see the values.
    pub async fn personal(&self) -> Result<PersonalDetails, ApiError> {
        self.request(Method::GET, &["me", "personal"], &[], NO_BODY)
            .await
    }

    /// Changes the details `update` sets; 400 for one that isn't one, such as an e-mail address,
    /// 403 for a player whose home is another assistant.
    pub async fn update_personal(
        &self,
        update: &UpdatePersonalRequest,
    ) -> Result<PersonalDetails, ApiError> {
        self.request(Method::PATCH, &["me", "personal"], &[], Some(update))
            .await
    }

    /// Lets the model in a shared room know where the caller is, for anyone there, or stops it.
    /// 400 for a room that isn't shared, 403 for a player whose home is another assistant.
    pub async fn share_location_in(
        &self,
        room: &str,
        shared: bool,
    ) -> Result<PersonalDetails, ApiError> {
        let body = ShareLocationRequest { shared };
        self.request(Method::PUT, &["rooms", room, "location"], &[], Some(&body))
            .await
    }

    /// The caller's profile: name, avatar, time zone, language and preferences.
    pub async fn profile(&self) -> Result<Profile, ApiError> {
        self.request(Method::GET, &["me", "profile"], &[], NO_BODY)
            .await
    }

    /// Changes the fields `update` sets; 400 for a value that isn't one, such as a time zone.
    pub async fn update_profile(&self, update: &UpdateProfileRequest) -> Result<Profile, ApiError> {
        self.request(Method::PATCH, &["me", "profile"], &[], Some(update))
            .await
    }

    /// The extensions that take settings from each player, with their schemas.
    pub async fn profile_extensions(&self) -> Result<Vec<PlayerSettingsSchema>, ApiError> {
        let response: PlayerSettingsResponse = self
            .request(Method::GET, &["me", "profile", "extensions"], &[], NO_BODY)
            .await?;
        Ok(response.extensions)
    }

    // Roaming, through the extension `federation`: 404 on an assistant without it. To join
    // another assistant, ask the home for an assertion with `vouch_for`, then pass it to `join`
    // on an `Api` of the assistant joined.

    /// Has the caller's home vouch for them to `place`, encrypted so only that assistant reads
    /// it.
    pub async fn vouch_for(&self, place: &PlaceRequest) -> Result<Sealed, ApiError> {
        let response: AssertResponse = self
            .request(
                Method::POST,
                &["ext", "federation", "assert"],
                &[],
                Some(place),
            )
            .await?;
        Ok(response.assertion)
    }

    /// Joins this assistant with an assertion from the caller's home, and stores the token.
    pub async fn join(&self, assertion: Sealed) -> Result<PairResponse, ApiError> {
        let body = JoinRequest { assertion };
        let joined: PairResponse = self
            .request(
                Method::POST,
                &["ext", "federation", "join"],
                &[],
                Some(&body),
            )
            .await?;
        self.tokens.set(Some(joined.token.clone()));
        Ok(joined)
    }

    /// The assistants the caller joined from here, their home, and the caller's address.
    pub async fn memberships(&self) -> Result<MembershipsResponse, ApiError> {
        self.request(
            Method::GET,
            &["ext", "federation", "memberships"],
            &[],
            NO_BODY,
        )
        .await
    }

    /// Starts or stops carrying the caller's own memory to an assistant they joined.
    pub async fn carry_memory(
        &self,
        place: &PlaceRequest,
        carry: bool,
    ) -> Result<Membership, ApiError> {
        let body = CarryMemoryRequest {
            server: place.server.clone(),
            assistant: place.assistant.clone(),
            carry,
        };
        self.request(
            Method::PUT,
            &["ext", "federation", "memberships", "memory"],
            &[],
            Some(&body),
        )
        .await
    }

    /// Stops sending the caller's profile and memory to an assistant they joined.
    pub async fn leave(&self, place: &PlaceRequest) -> Result<(), ApiError> {
        let query = [
            ("server", place.server.as_str()),
            ("assistant", place.assistant.as_str()),
        ];
        self.request_empty(
            Method::DELETE,
            &["ext", "federation", "memberships"],
            &query,
            NO_BODY,
        )
        .await
    }

    // The servers the caller owns, kept at their home so all their devices see them (ADR 11). On
    // another device, `owner_assertion` and `ServerApi::sign_in_from_home` give a server token.

    /// The servers the caller owns, as their home keeps them.
    pub async fn owned_servers(&self) -> Result<Vec<OwnedServer>, ApiError> {
        let response: OwnedServersResponse = self
            .request(Method::GET, &["ext", "federation", "servers"], &[], NO_BODY)
            .await?;
        Ok(response.servers)
    }

    /// Keeps a server the caller owns at home.
    pub async fn add_owned_server(&self, server: &str) -> Result<Vec<OwnedServer>, ApiError> {
        let body = ServerRequest {
            server: server.to_owned(),
        };
        let response: OwnedServersResponse = self
            .request(
                Method::PUT,
                &["ext", "federation", "servers"],
                &[],
                Some(&body),
            )
            .await?;
        Ok(response.servers)
    }

    /// Takes a server off the caller's list at home; nothing on the server changes.
    pub async fn remove_owned_server(&self, server: &str) -> Result<(), ApiError> {
        self.request_empty(
            Method::DELETE,
            &["ext", "federation", "servers"],
            &[("server", server)],
            NO_BODY,
        )
        .await
    }

    /// Has the caller's home vouch for them to a server they own, sealed for that server.
    pub async fn owner_assertion(&self, server: &str) -> Result<Sealed, ApiError> {
        let body = ServerRequest {
            server: server.to_owned(),
        };
        let response: AssertResponse = self
            .request(
                Method::POST,
                &["ext", "federation", "owner-assertion"],
                &[],
                Some(&body),
            )
            .await?;
        Ok(response.assertion)
    }

    // Admin routes, for players with the admin flag.

    /// How the assistant's robot looks; `None` goes back to the app icon's. Room lists show it.
    pub async fn set_appearance(
        &self,
        appearance: Option<Appearance>,
    ) -> Result<Option<Appearance>, ApiError> {
        let body = SetAppearanceRequest { appearance };
        let response: AppearanceResponse = self
            .request(Method::PUT, &["admin", "appearance"], &[], Some(&body))
            .await?;
        Ok(response.appearance)
    }

    /// Gives a player the admin flag, or with `false` takes it; the first player keeps it.
    pub async fn set_admin(&self, player_id: &str, admin: bool) -> Result<AdminPlayer, ApiError> {
        let body = SetAdminRequest { admin };
        self.request(
            Method::PUT,
            &["admin", "players", player_id, "admin"],
            &[],
            Some(&body),
        )
        .await
    }

    pub async fn create_player(&self, display_name: &str) -> Result<Player, ApiError> {
        let body = CreatePlayerRequest {
            display_name: display_name.to_owned(),
        };
        let response: PlayerResponse = self
            .request(Method::POST, &["admin", "players"], &[], Some(&body))
            .await?;
        Ok(response.player)
    }

    pub async fn pairing_code(&self, player_id: &str) -> Result<PairingCodeResponse, ApiError> {
        let body = PairingCodeRequest {
            player_id: player_id.to_owned(),
        };
        self.request(Method::POST, &["admin", "pairing-codes"], &[], Some(&body))
            .await
    }

    /// Every room of the assistant, not only the caller's.
    pub async fn all_rooms(&self) -> Result<Vec<Room>, ApiError> {
        let response: RoomsResponse = self
            .request(Method::GET, &["admin", "rooms"], &[], NO_BODY)
            .await?;
        Ok(response.rooms)
    }

    pub async fn list_tokens(&self, player_id: Option<&str>) -> Result<Vec<TokenInfo>, ApiError> {
        let query: Vec<(&str, &str)> = player_id.map(|id| ("player", id)).into_iter().collect();
        let response: TokensResponse = self
            .request(Method::GET, &["admin", "tokens"], &query, NO_BODY)
            .await?;
        Ok(response.tokens)
    }

    /// Revokes a client's token; its sockets close with 4401.
    pub async fn revoke(&self, client_id: &str) -> Result<(), ApiError> {
        self.request_empty(
            Method::DELETE,
            &["admin", "tokens", client_id],
            &[],
            NO_BODY,
        )
        .await
    }

    /// Lets the person at `address` (`name@server/assistant`) join, for a week.
    pub async fn invite(&self, address: &str) -> Result<InviteResponse, ApiError> {
        let body = InviteRequest {
            address: address.to_owned(),
        };
        self.request(
            Method::POST,
            &["ext", "federation", "invites"],
            &[],
            Some(&body),
        )
        .await
    }

    pub async fn invites(&self) -> Result<Vec<Invite>, ApiError> {
        let response: InvitesResponse = self
            .request(Method::GET, &["ext", "federation", "invites"], &[], NO_BODY)
            .await?;
        Ok(response.invites)
    }

    pub async fn cancel_invite(&self, id: &str) -> Result<(), ApiError> {
        self.request_empty(
            Method::DELETE,
            &["ext", "federation", "invites", id],
            &[],
            NO_BODY,
        )
        .await
    }

    /// The assistant's extensions and the ones it could add, with their settings and schemas;
    /// 404 when the server can't set up extensions.
    pub async fn extension_setups(&self) -> Result<Vec<ExtensionSetup>, ApiError> {
        let response: ExtensionSetupsResponse = self
            .request(Method::GET, &["admin", "extensions"], &[], NO_BODY)
            .await?;
        Ok(response.extensions)
    }

    /// Installs `extensions`, in order, in place of the assistant's, and keeps them in its
    /// config; 400, and nothing changed, when one won't start.
    pub async fn save_extension_setups(
        &self,
        extensions: Vec<SavedExtensionSetup>,
    ) -> Result<Vec<ExtensionSetup>, ApiError> {
        let body = SaveExtensionSetupsRequest { extensions };
        let response: ExtensionSetupsResponse = self
            .request(Method::PUT, &["admin", "extensions"], &[], Some(&body))
            .await?;
        Ok(response.extensions)
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, &str)],
        body: Option<&impl Serialize>,
    ) -> Result<T, ApiError> {
        read(self.build(method, path, query, body).send().await).await
    }

    /// A request answered with 204 No Content.
    async fn request_empty(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, &str)],
        body: Option<&impl Serialize>,
    ) -> Result<(), ApiError> {
        checked(self.build(method, path, query, body).send().await)
            .await
            .map(drop)
    }

    fn build(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, &str)],
        body: Option<&impl Serialize>,
    ) -> reqwest::RequestBuilder {
        let mut url = endpoint(&self.base, path);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let mut request = self.http.request(method, url);
        if let Some(token) = self.tokens.get() {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        request
    }
}

const NO_BODY: Option<&()> = None;

pub(crate) fn parse_server(server: &str) -> Result<Url, ApiError> {
    let url = Url::parse(server).map_err(|_| ApiError::Address(server.to_owned()))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err(ApiError::Address(server.to_owned())),
    }
}

/// `base` with `segments` added to its path, each escaped.
pub(crate) fn endpoint(base: &Url, segments: &[&str]) -> Url {
    let mut url = base.clone();
    url.path_segments_mut()
        .expect("http(s) addresses have a path")
        .pop_if_empty()
        .extend(segments);
    url
}

pub(crate) async fn checked(
    response: reqwest::Result<reqwest::Response>,
) -> Result<reqwest::Response, ApiError> {
    let response = response.map_err(|error| ApiError::Network(error.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let (message, code) = match response.json::<ErrorResponse>().await {
        Ok(body) => (body.error, body.code),
        Err(_) => (
            status
                .canonical_reason()
                .unwrap_or("Request failed")
                .to_owned(),
            None,
        ),
    };
    Err(error_for(
        status.as_u16(),
        message,
        code.as_deref(),
        retry_after,
    ))
}

/// The error a non-2xx answer is, by its status and the server's `code`; a code this client
/// doesn't know is no code.
pub(crate) fn error_for(
    status: u16,
    message: String,
    code: Option<&str>,
    retry_after: Option<u64>,
) -> ApiError {
    match (status, code) {
        (429, Some(error_code::RATE_LIMITED)) => ApiError::RateLimited {
            message,
            retry_after,
        },
        (429, Some(error_code::BUDGET_SPENT)) => ApiError::BudgetSpent(message),
        _ => ApiError::Status { status, message },
    }
}

pub(crate) async fn read<T: DeserializeOwned>(
    response: reqwest::Result<reqwest::Response>,
) -> Result<T, ApiError> {
    let response = checked(response).await?;
    if response.status() == StatusCode::NO_CONTENT {
        return serde_json::from_value(serde_json::Value::Null)
            .map_err(|error| ApiError::Decode(error.to_string()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ApiError::Network(error.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|error| ApiError::Decode(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_escaped_paths_under_the_server_path() {
        let tokens: Arc<dyn TokenStore> = Arc::new(MemoryTokens::default());
        let api = Api::new("https://example.com/nudge/", "robin", tokens).unwrap();
        assert_eq!(
            endpoint(&api.base, &["rooms", "a b/c", "messages"]).as_str(),
            "https://example.com/nudge/v1/a/robin/rooms/a%20b%2Fc/messages"
        );
        assert!(matches!(
            Api::new(
                "ws://example.com",
                "robin",
                Arc::new(MemoryTokens::default())
            ),
            Err(ApiError::Address(_))
        ));
    }

    /// What `checked` makes of one raw HTTP answer from a server that answers once.
    async fn answer(headers: &str, body: &str) -> ApiError {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let raw = format!(
            "HTTP/1.1 429 Too Many Requests\r\n{headers}content-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request).await;
            socket.write_all(raw.as_bytes()).await.unwrap();
        });
        checked(reqwest::get(format!("http://{address}/")).await)
            .await
            .unwrap_err()
    }

    #[tokio::test]
    async fn tells_a_rate_limit_from_a_spent_budget() {
        let limited = answer(
            "retry-after: 7\r\n",
            r#"{"error":"Too many requests; try again in 7 s","code":"rate_limited"}"#,
        )
        .await;
        assert_eq!(
            limited,
            ApiError::RateLimited {
                message: "Too many requests; try again in 7 s".into(),
                retry_after: Some(7),
            }
        );
        assert!(limited.is_retryable());
        assert_eq!(limited.status(), Some(429));

        let spent = answer(
            "",
            r#"{"error":"You have used your budget for the month.","code":"budget_spent"}"#,
        )
        .await;
        assert_eq!(
            spent,
            ApiError::BudgetSpent("You have used your budget for the month.".into())
        );
        assert!(!spent.is_retryable());
        assert_eq!(spent.status(), Some(429));

        // A code this client doesn't know, or none, is a plain status.
        let other = answer("", r#"{"error":"Slow down","code":"new"}"#).await;
        assert_eq!(
            other,
            ApiError::Status {
                status: 429,
                message: "Slow down".into(),
            }
        );
        assert!(!other.is_retryable());
    }
}
