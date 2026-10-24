# Running a server

## Updates

A server updates itself: every hour it looks for a newer release, installs one the project signed, and starts it. The new one keeps itself once it has run for 30 seconds and its own `GET /v1/health` answers `ok`; if it stops before that, or isn't healthy within 5 minutes, `nudge-server` goes back to the one before and doesn't try it again. The data directory records the format its data is in (`server/data-format`; `DATA_FORMAT` in [`packages/core/src/server/data-format.ts`](../packages/core/src/server/data-format.ts), bumped by a release whose data an older one can't read). A release won't start on data newer than it reads, and one that moves the data to a newer format first takes a backup into `server/before-update/` and keeps itself, so there is no rollback past the move: going back means restoring that backup (`nudge restore`) under the older release. Owners see this at `GET /v1/server` and can turn it off (`PUT /v1/server/updates`).

## Logs and health

Errors go to stderr as JSON lines, one object each with `time`, `level`, `msg` and the assistant, room and route they were for (`journalctl -u nudge` or `docker compose logs`). `NUDGE_LOG_LEVEL` sets the lowest level written (`debug`, `info`, `warn`, `error`; default `info`) and `NUDGE_LOG_FORMAT` the shape (`json`, or `text` for a person; default `text` on a terminal, `json` otherwise). Keys, tokens, e-mail addresses and phone numbers are scrubbed from every line, and a failed model request is logged as the provider answered it, with placeholders where personal values were. `GET /v1/health` answers without a token, for a monitor: `{ ok, assistants, lastModelErrorAgeSeconds? }`, naming nothing. Owners see the last 20 failed model requests under `errors` at `GET /v1/server`.

## Releases

Releases are made by pushing a tag such as `v0.2.0` ([`.github/workflows/release.yml`](../.github/workflows/release.yml)): an archive per architecture from [`packages/release/scripts/bundle.sh`](../packages/release/scripts/bundle.sh), a `manifest.json` signed with the `NUDGE_RELEASE_KEY` secret, and the image. Make that key once with `node packages/release/scripts/keygen.mjs`, and put its public half in `RELEASE_KEYS` (`packages/core/src/server/updates.ts`); until then servers don't update themselves.
