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
            assertion: None,
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

    /// Trades an assertion from the owner's home, from `Api::owner_assertion`, for a server token,
    /// and stores it: for a device with no player token on `assistant`.
    pub async fn sign_in_from_home(
        &self,
        assistant: &str,
        assertion: Sealed,
        client: ClientInfo,
    ) -> Result<ServerSessionResponse, ApiError> {
        let body = ServerSessionRequest {
            assistant: assistant.to_owned(),
            client,
            assertion: Some(assertion),
        };
        let session: ServerSessionResponse = read(
            self.http
                .post(endpoint(&self.base, &["session"]))
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

    /// Invites `address` to the assistant through its federation, as an admin would; the link
    /// their app joins with from home.
    pub async fn invite(&self, assistant: &str, address: &str) -> Result<String, ApiError> {
        let body = InviteToAssistantRequest {
            address: address.to_owned(),
        };
        let response: InviteToAssistantResponse = self
            .request(
                Method::POST,
                &["assistants", assistant, "invites"],
                &[],
                Some(&body),
            )
            .await?;
        Ok(response.join_link)
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

    /// Makes a player of one of the server's assistants an owner too, and with `admin` an admin
    /// of that assistant.
    pub async fn add_owner(
        &self,
        assistant: &str,
        player_id: &str,
        admin: bool,
    ) -> Result<ServerOwner, ApiError> {
        let body = AddOwnerRequest {
            assistant: assistant.to_owned(),
            player_id: player_id.to_owned(),
            admin: admin.then_some(true),
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

    /// The server's Wired; 404 on a server that wasn't given one.
    pub async fn wired(&self) -> Result<WiredState, ApiError> {
        self.request(Method::GET, &["wired"], &[], NO_BODY).await
    }

    /// Takes the server out of Wired: it leaves the network, or stops holding it, and forgets it.
    pub async fn disable_wired(&self) -> Result<WiredState, ApiError> {
        self.request(Method::DELETE, &["wired"], &[], NO_BODY).await
    }

    /// Makes the server the root of its own Wired network.
    pub async fn enable_wired(&self) -> Result<WiredState, ApiError> {
        self.request(Method::POST, &["wired"], &[], NO_BODY).await
    }

    /// Joins the network `invite` is for, serving a relay at the server's public HTTPS address (or
    /// `relay_url`), which the root must have listed first (`add_wired_relay` there).
    pub async fn join_wired(
        &self,
        invite: &str,
        relay_url: Option<&str>,
    ) -> Result<WiredState, ApiError> {
        let body = WiredJoinRequest {
            invite: invite.to_owned(),
            relay_url: relay_url.map(str::to_owned),
        };
        self.request(Method::POST, &["wired", "join"], &[], Some(&body))
            .await
    }

    /// On the root: lists the relay a new server will serve at `url` (its public HTTPS address),
    /// so the network can reach it before it joins, and answers with the invite it joins with.
    pub async fn add_wired_relay(&self, url: &str) -> Result<String, ApiError> {
        let body = WiredRelayRequest {
            url: url.to_owned(),
        };
        let answer: WiredRelayResponse = self
            .request(Method::POST, &["wired", "relays"], &[], Some(&body))
            .await?;
        Ok(answer.invite)
    }

    /// On the root: removes the server called `name` from the network, as when it was deleted;
    /// its key is refused from then on, and a new server can take the name.
    pub async fn remove_wired_member(&self, name: &str) -> Result<WiredState, ApiError> {
        self.request(Method::DELETE, &["wired", "members", name], &[], NO_BODY)
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

/// Who can reach a server at its address: anyone (`Public`), only the same Wired network (`Wired`:
/// `<service>.<name>.wired`), or only the same network (`Private`: this computer, a LAN or VPN
/// address, such as a tailnet's, or a local name). Another server reaches a Wired one only once
/// it is in that network, and a private one not at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    Public,
    Wired,
    Private,
}

pub fn reach(server: &str) -> Reach {
    let Ok(url) = parse_server(server) else {
        return Reach::Private;
    };
    match url.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.to_ascii_lowercase();
            if name.ends_with(".wired") {
                Reach::Wired
            } else if !name.contains('.')
                || [
                    ".local",
                    ".lan",
                    ".home.arpa",
                    ".internal",
                    ".localhost",
                    ".ts.net",
                ]
                .iter()
                .any(|suffix| name.ends_with(suffix))
            {
                Reach::Private
            } else {
                Reach::Public
            }
        }
        Some(url::Host::Ipv4(ip)) => {
            let [a, b, ..] = ip.octets();
            // 100.64.0.0/10 is carrier-grade NAT, such as a tailnet's.
            if ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || (a == 100 && (64..=127).contains(&b))
            {
                Reach::Private
            } else {
                Reach::Public
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            let s = ip.segments();
            if ip.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 {
                Reach::Private
            } else {
                Reach::Public
            }
        }
        None => Reach::Private,
    }
}

#[cfg(test)]
mod tests {
    use super::{Reach, reach};

    #[test]
    fn tells_who_can_reach_an_address() {
        assert_eq!(reach("https://home.tail1234.ts.net"), Reach::Private);
        assert_eq!(reach("http://100.101.102.103:8787"), Reach::Private);
        assert_eq!(reach("http://[fd7a:115c:a1e0::1]:8787"), Reach::Private);
        assert_eq!(reach("http://192.168.1.5:8787"), Reach::Private);
        assert_eq!(reach("http://127.0.0.1:8787"), Reach::Private);
        assert_eq!(reach("http://nudge.local:8787"), Reach::Private);
        assert_eq!(reach("http://homeserver:8787"), Reach::Private);
        assert_eq!(reach("http://100.63.0.1:8787"), Reach::Public);
        assert_eq!(reach("https://robin.exe.xyz"), Reach::Public);
        assert_eq!(reach("https://ts.net.example.com"), Reach::Public);
        assert_eq!(reach("http://nudge.box.wired"), Reach::Wired);
        assert_eq!(reach("not a url"), Reach::Private);
    }
}
