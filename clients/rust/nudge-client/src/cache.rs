use std::path::Path;
use std::sync::Mutex;

use nudge_protocol::{Target, WhenBusy};
use rusqlite::{OptionalExtension, params};

/// What a client keeps on disk between runs: the last view of every target it followed, shown
/// while the socket reconnects, and its outbox, the messages it hasn't got to the server yet.
/// Everything here is a copy or a wish; the server has the truth. Errors after opening are
/// ignored, so a full disk costs the cache, not the client.
pub struct Cache {
    db: Mutex<rusqlite::Connection>,
}

/// A message in the outbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    pub request_id: String,
    pub room: String,
    pub text: String,
    pub when_busy: Option<WhenBusy>,
    /// Only the sender sees it and the answer to it.
    pub private: bool,
    /// Ms since the epoch.
    pub created_at: i64,
    /// Why the server refused it; it is not sent again until `resend`.
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("Cannot open the cache: {0}")]
pub struct CacheError(#[from] rusqlite::Error);

impl Cache {
    pub fn open(path: &Path) -> Result<Cache, CacheError> {
        let db = rusqlite::Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "wal")?;
        Self::with(db)
    }

    /// A cache that lasts as long as the client: an outbox, but nothing kept between runs.
    pub fn in_memory() -> Cache {
        Self::with(rusqlite::Connection::open_in_memory().expect("SQLite opens in memory"))
            .expect("an empty database migrates")
    }

    fn with(db: rusqlite::Connection) -> Result<Cache, CacheError> {
        db.execute_batch(
            "create table if not exists meta (key text primary key, value text not null);
             create table if not exists views (target text primary key, view text not null);
             create table if not exists outbox (
               request_id text primary key,
               room text not null,
               text text not null,
               when_busy text,
               created_at integer not null,
               error text
             );",
        )?;
        // Caches from before private messages lack the column.
        let has_private = db
            .prepare("select 1 from pragma_table_info('outbox') where name = 'private'")?
            .exists([])?;
        if !has_private {
            db.execute_batch("alter table outbox add column private integer not null default 0")?;
        }
        Ok(Cache { db: Mutex::new(db) })
    }

    /// The player the cached views and outbox belong to.
    pub fn player(&self) -> Option<String> {
        let db = self.db.lock().unwrap();
        db.query_row("select value from meta where key = 'player'", [], |row| {
            row.get(0)
        })
        .optional()
        .ok()
        .flatten()
    }

    /// Makes the cache `player`'s: when it was another player's, its views and outbox go.
    pub fn claim(&self, player: &str) {
        let owner = self.player();
        if owner.as_deref() == Some(player) {
            return;
        }
        let db = self.db.lock().unwrap();
        if owner.is_some() {
            let _ = db.execute_batch("delete from views; delete from outbox;");
        }
        let _ = db.execute(
            "insert or replace into meta (key, value) values ('player', ?1)",
            params![player],
        );
    }

    pub fn view(&self, target: &Target) -> Option<String> {
        let db = self.db.lock().unwrap();
        db.query_row(
            "select view from views where target = ?1",
            params![target.to_string()],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn save_view(&self, target: &Target, view: &str) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "insert or replace into views (target, view) values (?1, ?2)",
            params![target.to_string(), view],
        );
    }

    pub fn forget_view(&self, target: &Target) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "delete from views where target = ?1",
            params![target.to_string()],
        );
    }

    /// The outbox, oldest first; only `room`'s messages when given.
    pub fn outbox(&self, room: Option<&str>) -> Vec<Outgoing> {
        let db = self.db.lock().unwrap();
        let read = |row: &rusqlite::Row<'_>| {
            let when_busy: Option<String> = row.get(3)?;
            Ok(Outgoing {
                request_id: row.get(0)?,
                room: row.get(1)?,
                text: row.get(2)?,
                when_busy: when_busy.and_then(|text| serde_json::from_value(text.into()).ok()),
                created_at: row.get(4)?,
                error: row.get(5)?,
                private: row.get(6)?,
            })
        };
        let columns =
            "select request_id, room, text, when_busy, created_at, error, private from outbox";
        let rows = match room {
            Some(room) => db
                .prepare(&format!(
                    "{columns} where room = ?1 order by created_at, rowid"
                ))
                .and_then(|mut query| query.query_map(params![room], read)?.collect()),
            None => db
                .prepare(&format!("{columns} order by created_at, rowid"))
                .and_then(|mut query| query.query_map([], read)?.collect()),
        };
        rows.unwrap_or_default()
    }

    pub fn add_outgoing(&self, message: &Outgoing) {
        let when_busy = message.when_busy.map(|mode| {
            serde_json::to_value(mode)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        });
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "insert or replace into outbox
               (request_id, room, text, when_busy, created_at, error, private)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                message.request_id,
                message.room,
                message.text,
                when_busy,
                message.created_at,
                message.error,
                message.private
            ],
        );
    }

    pub fn set_outgoing_error(&self, request_id: &str, error: Option<&str>) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "update outbox set error = ?2 where request_id = ?1",
            params![request_id, error],
        );
    }

    pub fn remove_outgoing(&self, request_id: &str) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "delete from outbox where request_id = ?1",
            params![request_id],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, room: &str, at: i64) -> Outgoing {
        Outgoing {
            request_id: id.into(),
            room: room.into(),
            text: format!("text {id}"),
            when_busy: Some(WhenBusy::Steer),
            private: true,
            created_at: at,
            error: None,
        }
    }

    #[test]
    fn keeps_views_and_the_outbox_between_runs() {
        let dir = std::env::temp_dir().join(format!("nudge-cache-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cache.sqlite");
        {
            let cache = Cache::open(&path).unwrap();
            cache.claim("ann");
            cache.save_view(&Target::RoomList, "{\"rooms\":1}");
            cache.add_outgoing(&message("b", "trip", 2));
            cache.add_outgoing(&message("a", "trip", 1));
            cache.add_outgoing(&message("c", "lobby", 3));
            cache.set_outgoing_error("c", Some("Not a member"));
        }
        let cache = Cache::open(&path).unwrap();
        assert_eq!(cache.player().as_deref(), Some("ann"));
        assert_eq!(
            cache.view(&Target::RoomList).as_deref(),
            Some("{\"rooms\":1}")
        );
        assert_eq!(cache.view(&Target::Room("trip".into())), None);
        let ids: Vec<String> = cache
            .outbox(Some("trip"))
            .into_iter()
            .map(|m| m.request_id)
            .collect();
        assert_eq!(ids, ["a", "b"]);
        let all = cache.outbox(None);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].when_busy, Some(WhenBusy::Steer));
        assert_eq!(all[2].error.as_deref(), Some("Not a member"));
        cache.remove_outgoing("a");
        assert_eq!(cache.outbox(None).len(), 2);
        // Another player's client starts afresh.
        cache.claim("bo");
        assert_eq!(cache.view(&Target::RoomList), None);
        assert!(cache.outbox(None).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
