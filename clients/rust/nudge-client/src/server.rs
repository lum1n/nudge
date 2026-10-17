use std::sync::Arc;

use nudge_protocol::*;
use reqwest::Method;
use serde::Serialize;
use serde::de::DeserializeOwned;
use url::Url;

use crate::api::{ApiError, TokenStore, checked, endpoint, parse_server, read};

/// The server's own API (ADR 11), for its owners: its assistants, the model keys set on it, who
/// owns it and its updates. Signed in with a server token (`nudge_server_…`), which an owner gets
/// from `sign_in` with the token of their player on one of the server's assistants, or from setup.
#[derive(Clone)]
pub struct ServerApi {
    base: Url,
    tokens: Arc<dyn TokenStore>,
    http: reqwest::Client,
}

impl ServerApi {
    /// `server` is the server's address, such as `https://robin.exe.xyz`.
    pub fn new(server: &str, tokens: Arc<dyn TokenStore>) -> Result<Self, ApiError> {
        Ok(ServerApi {
            base: endpoint(&parse_server(server)?, &["v1", "server"]),
            tokens,
            http: reqwest::Client::new(),
        })
    }

    pub fn tokens(&self) -> &Arc<dyn TokenStore> {
        &self.tokens
    }

    /// Trades the player token of an owner, on `assistant`, for a server token, and stores it.
    pub async fn sign_in(
        &self,
        assistant: &str,
        player_token: &str,
        client: ClientInfo,
    ) -> Result<ServerSessionResponse, ApiError> {
        let body = ServerSessionRequest {
            assistant: assistant.to_owned(),
            client,
        };
        let session: ServerSessionResponse = read(
            self.http
                .post(endpoint(&self.base, &["session"]))
                .bearer_auth(player_token)
                .json(&body)
                .send()
                .await,
        )
        .await?;
        self.tokens.set(Some(session.token.clone()));
        Ok(session)
    }

    /// Revokes this client's server token, and forgets it.
    pub async fn sign_out(&self) -> Result<(), ApiError> {
        self.empty(Method::DELETE, &["session"], &[], NO_BODY)
            .await?;
        self.tokens.set(None);
        Ok(())
    }

    pub async fn info(&self) -> Result<ServerInfoResponse, ApiError> {
        self.request(Method::GET, &[], &[], NO_BODY).await
    }

    pub async fn assistants(&self) -> Result<Vec<ServerAssistant>, ApiError> {
        let response: ServerAssistantsResponse = self
            .request(Method::GET, &["assistants"], &[], NO_BODY)
            .await?;
        Ok(response.assistants)
    }

    /// With `first_player`, it is that person's home and the answer has their pairing code; with
    /// `invite`, that address may join it, and the answer has the link.
    pub async fn create_assistant(
        &self,
        body: &CreateAssistantRequest,
    ) -> Result<CreateAssistantResponse, ApiError> {
        self.request(Method::POST, &["assistants"], &[], Some(body))
            .await
    }

    /// The assistant reopens with the change, so its sockets close and clients connect again.
    pub async fn update_assistant(
        &self,
        name: &str,
        change: &UpdateAssistantRequest,
    ) -> Result<ServerAssistant, ApiError> {
        self.request(Method::PATCH, &["assistants", name], &[], Some(change))
            .await
    }

    /// Deletes it for good, after a backup the server keeps for a while; returns its name.
    pub async fn delete_assistant(&self, name: &str) -> Result<String, ApiError> {
        let response: DeleteAssistantResponse = self
            .request(Method::DELETE, &["assistants", name], &[], NO_BODY)
            .await?;
        Ok(response.backup)
    }

    /// Where each provider's key comes from, for every assistant or for `assistant`.
    pub async fn keys(&self, assistant: Option<&str>) -> Result<Vec<ProviderKey>, ApiError> {
        let query: Vec<(&str, &str)> = assistant.map(|a| ("assistant", a)).into_iter().collect();
        let response: ProviderKeysResponse = self
            .request(Method::GET, &["keys"], &query, NO_BODY)
            .await?;
        Ok(response.keys)
    }

    /// Keeps a provider's key on the server once it answered a tiny request (unless `test` is
    /// `Some(false)`); a 400 has the provider's answer.
    pub async fn set_key(
        &self,
        provider: &str,
        body: &SetProviderKeyRequest,
    ) -> Result<ProviderKey, ApiError> {
        self.request(Method::PUT, &["keys", provider], &[], Some(body))
            .await
    }

    pub async fn delete_key(
        &self,
        provider: &str,
        assistant: Option<&str>,
    ) -> Result<(), ApiError> {
        let query: Vec<(&str, &str)> = assistant.map(|a| ("assistant", a)).into_iter().collect();
        self.empty(Method::DELETE, &["keys", provider], &query, NO_BODY)
            .await
    }

    pub async fn owners(&self) -> Result<Vec<ServerOwner>, ApiError> {
        let response: ServerOwnersResponse =
            self.request(Method::GET, &["owners"], &[], NO_BODY).await?;
        Ok(response.owners)
    }

    /// Makes a player of one of the server's assistants an owner too.
    pub async fn add_owner(
        &self,
        assistant: &str,
        player_id: &str,
    ) -> Result<ServerOwner, ApiError> {
        let body = AddOwnerRequest {
            assistant: assistant.to_owned(),
            player_id: player_id.to_owned(),
        };
        self.request(Method::POST, &["owners"], &[], Some(&body))
            .await
    }

    /// Refused (409) for the last owner.
    pub async fn remove_owner(&self, id: &str) -> Result<(), ApiError> {
        self.empty(Method::DELETE, &["owners", id], &[], NO_BODY)
            .await
    }

    /// Looks for a newer release now; the server installs it when updates are automatic.
    pub async fn check_updates(&self) -> Result<UpdateState, ApiError> {
        self.request(Method::POST, &["updates", "check"], &[], NO_BODY)
            .await
    }

    pub async fn set_updates(&self, automatic: bool) -> Result<UpdateState, ApiError> {
        let body = SetUpdatesRequest { automatic };
        self.request(Method::PUT, &["updates"], &[], Some(&body))
            .await
    }

    /// The backup key, sealed with `passphrase`, as a file to keep away from the server.
    pub async fn recovery_kit(&self, passphrase: &str) -> Result<String, ApiError> {
        let body = RecoveryKitRequest {
            passphrase: passphrase.to_owned(),
        };
        let response: RecoveryKitResponse = self
            .request(Method::POST, &["recovery-kit"], &[], Some(&body))
            .await?;
        Ok(response.kit)
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

    async fn empty(
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

/// Setup mode (ADR 11): whether `server` waits to be set up, and what it offers. Needs no token;
/// the one-time code it printed goes with every other step.
pub async fn setup_info(server: &str) -> Result<SetupInfoResponse, ApiError> {
    let url = endpoint(&parse_server(server)?, &["v1", "setup"]);
    read(reqwest::Client::new().get(url).send().await).await
}

/// Whether `code` is the setup code; a wrong one is a 401, and counts against a few tries.
pub async fn check_setup_code(server: &str, code: &str) -> Result<(), ApiError> {
    let url = endpoint(&parse_server(server)?, &["v1", "setup", "code"]);
    let body = SetupCodeRequest {
        code: code.to_owned(),
    };
    checked(reqwest::Client::new().post(url).json(&body).send().await)
        .await
        .map(drop)
}

/// Tries a provider's key with one tiny request; a 400 has the provider's answer.
pub async fn check_setup_key(server: &str, body: &SetupKeyRequest) -> Result<(), ApiError> {
    let url = endpoint(&parse_server(server)?, &["v1", "setup", "key"]);
    checked(reqwest::Client::new().post(url).json(body).send().await)
        .await
        .map(drop)
}

/// Sets the server up; the answer has the player's token and the owner's server token.
pub async fn set_up(server: &str, body: &SetupRequest) -> Result<SetupResponse, ApiError> {
    let url = endpoint(&parse_server(server)?, &["v1", "setup"]);
    read(reqwest::Client::new().post(url).json(body).send().await).await
}
