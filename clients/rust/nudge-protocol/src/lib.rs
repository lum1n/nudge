//! Nudge's client protocol v1 for Rust: the shapes of its frames, views and HTTP bodies, and
//! `apply` for the patches the server sends. No IO; `nudge-client` does the talking.

mod apply;
mod schema;

pub use apply::{ApplyError, apply, apply_in_place};
pub use schema::*;
