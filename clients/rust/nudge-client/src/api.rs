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
    /// Whether the same request may work later: no answer, or the server failed (5xx). Messages
    /// are safe to send again, since the server answers a repeated `requestId` with the same
    /// submission.
    pub fn is_retryable(&self) -> bool {
        match self {
            ApiError::Network(_) => true,
            ApiError::Status { status, .. } => *status >= 500,
            _ => false,
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            ApiError::Status { status, .. } => Some(*status),
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
    ) -> Result<Approval, ApiError> {
        let body = DecideRequest { approve };
        self.request(
            Method::POST,
            &["rooms", room, "approvals", approval],
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
        self.request(Method::GET, &["devices"], &[], NO_BODY).await
    }

    /// Has the server push to this device when one of the player's rooms has news and they don't
    /// have it open. Registering again with the same token replaces the old one.
    pub async fn register_device(&self, device: &DeviceRequest) -> Result<(), ApiError> {
        self.request_empty(Method::POST, &["devices"], &[], Some(device))
            .await
    }

    pub async fn unregister_device(&self, token: &str) -> Result<(), ApiError> {
        self.request_empty(Method::DELETE, &["devices", token], &[], NO_BODY)
            .await
    }

    // Admin routes, for players with the admin flag.

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

fn parse_server(server: &str) -> Result<Url, ApiError> {
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

async fn checked(
    response: reqwest::Result<reqwest::Response>,
) -> Result<reqwest::Response, ApiError> {
    let response = response.map_err(|error| ApiError::Network(error.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let message = match response.json::<ErrorResponse>().await {
        Ok(body) => body.error,
        Err(_) => status
            .canonical_reason()
            .unwrap_or("Request failed")
            .to_owned(),
    };
    Err(ApiError::Status {
        status: status.as_u16(),
        message,
    })
}

async fn read<T: DeserializeOwned>(
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
}
