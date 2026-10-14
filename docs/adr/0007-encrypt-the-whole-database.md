# 7. Encrypt the whole database, not the vault

ADR 2 keeps personal values away from the model, but the host stores them in the clear. The vault holds each value with its placeholder, and the transcript holds the same values again (user messages, tool calls and results, answers), as do memory, nudges, approvals and the directory. Encrypting only the vault would leave all of that readable, so it protects nothing.

Nudge encrypts the whole SQLite file instead. Pi Durable's `SqliteStorage` accepts any `SqliteDatabase`, and its own `NodeSqliteDatabase` adapter only needs `exec`, `prepare` and `close`, which better-sqlite3 also provides. So an encrypted database is opened with [SQLite3 Multiple Ciphers](https://utelle.github.io/SQLite3MultipleCiphers/) (`better-sqlite3-multiple-ciphers`, default cipher ChaCha20-Poly1305, WAL included), and an unencrypted one still uses `node:sqlite`.

- The 16-byte file header shows which kind a file is.
- The key is `NUDGE_DB_KEY` or a `<database>.key` file, the same pattern as the secrets and login stores.
- `nudge db encrypt|decrypt` rekeys the file in place, outside WAL mode, and checks the result.
- Opt-in, because losing the key loses the data.

This protects copies of the file and backups, not a host where someone can read the key too. The cost is a native dependency, with prebuilds for the usual platforms. A Durable Object host would rely on its platform's encryption instead.

Storing transcripts redacted and rehydrating them for each viewer is the stronger option: forgetting a value would remove it from all history, and it is how per-person visibility would work. It touches tools, documents, compaction and every reader of the transcript, so it waits until per-person visibility is built.
