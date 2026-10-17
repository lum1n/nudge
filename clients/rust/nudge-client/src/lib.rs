//! A client of Nudge's protocol v1, after `@nudge/client`: `Api` wraps the HTTP commands,
//! `Connection` keeps the socket, `RoomListStore` and `RoomStore` follow views, and `NudgeClient`
//! puts them together with leases on views and an outbox that survives restarts.

mod api;
mod cache;
mod client;
mod connection;
mod exe;
mod exe_login;
mod panel;
mod push;
mod server;
mod stores;

pub use api::{
    Api, ApiError, MemoryTokens, PageRequest, TokenStore, list_assistants, register_with_relay,
};
pub use cache::{Cache, CacheError, Outgoing};
pub use client::{
    ClientConfig, ClientError, Lease, NudgeClient, SendOptions, Sent, new_request_id,
};
pub use connection::{
    AlreadyWatched, Backoff, Connection, ConnectionOptions, ConnectionStatus, OnError, QUIET,
    Subscriber, TargetFrame, Watch, connect_url,
};
pub use exe::{
    ExeDev, ExeError, ExeVm, LaunchedServer, NUDGE_IMAGE, NUDGE_PORT, new_setup_code,
    wait_for_setup,
};
pub use exe_login::{
    EXE_HOST_KEY, EXE_TOKEN_COMMANDS, ExeKey, ExeLogin, ExeScreen, mint_exe_token, new_exe_key,
};
pub use nudge_protocol as protocol;
pub use panel::{PanelListener, PanelSocket, PanelStatus, panel_url};
pub use push::{DeviceKey, PushPayload, open_push};
pub use server::{ServerApi, check_setup_code, check_setup_key, set_up, setup_info};
pub use stores::{
    PageLoader, PendingMessage, PendingState, RoomListStore, RoomState, RoomStore, SyncStatus,
    ViewState, slide,
};
