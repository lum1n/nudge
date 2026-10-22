# Nudge

An extendable, multiplayer personal assistant that keeps personal data away from model providers. Lightweight, self-hostable, and embeddable as a library. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

> Early work in progress. Pi Durable is experimental and changes without notice, so Nudge pins exact versions.

## Packages

- `@nudge/core`: the embeddable library. One `Nudge` is one assistant: one storage, one Harness, one registry.
- `@nudge/server`: an HTTP and WebSocket API over one or more assistants.
- `@nudge/cloudflare`: runs assistants on Cloudflare, one Durable Object each (`packages/cloudflare`).
- `@nudge/protocol`: the types of [protocol v1](docs/protocol/v1.md), its JSON schema, and the room projector.
- `@nudge/client`: the TypeScript client of protocol v1.
- `clients/rust`: the Rust client of protocol v1 (`nudge-protocol`, `nudge-client`), and its UniFFI bindings for Swift, Kotlin and Python (`nudge-ffi`).
- `clients/python`: the Python package `nudge-client` (asyncio), built on `nudge-ffi` with maturin.
- `clients/android`: the Android library (Kotlin, `StateFlow`s).
- `clients/apple`: the Swift package (`@Observable` models) for iOS and macOS.
- `@nudge/cli`: the `nudge` command.
- `@nudge/web`: the web UI (`apps/web`), served by `nudge serve`.
- `apps/apple`: the Nudge app for iPhone, iPad and Mac (SwiftUI, on `clients/apple`).
- `apps/android`: the Nudge app for Android (Compose, on `clients/android`).
- `@nudge/ext-hello`: a sample extension (`extensions/hello`).
- `@nudge/ext-browser`: lets the assistant use the web (`extensions/browser`).
- `@nudge/ext-desktop`: lets the assistant use desktop apps on Linux (`extensions/desktop`).
- `@nudge/ext-terminal`: lets the assistant run shell commands in a sandboxed workspace (`extensions/terminal`).
- `@nudge/ext-mcp`: gives the assistant the tools of MCP servers (`extensions/mcp`).
- `@nudge/ext-codemode`: lets the model run short scripts that call the room's tools (`extensions/codemode`).
- `@nudge/ext-federation`: lets people from other assistants join, with their home vouching for them (`extensions/federation`).
- `@nudge/ext-peers`: lets linked assistants on other servers talk to each other (`extensions/peers`).
- `@nudge/ext-push`: notifications of answers and approvals, through Web Push, APNs and FCM (`extensions/push`).
- `@nudge/ext-rss`: RSS and Atom feeds the assistant checks first for news (`extensions/rss`).
- `@nudge/ext-triggers`: secret web addresses that let outside events start a turn in a room (`extensions/triggers`).
- `@nudge/ext-acc`: lets the assistant start, watch and steer coding agents on your machines over SSH (`extensions/acc`).

## Install a server

On a Linux machine (a home server, a Pi, a VPS):

```bash
curl -fsSL https://raw.githubusercontent.com/lum1n/nudge/main/packages/release/install.sh | sh
```

It installs the newest release with its own Node into `~/.local/share/nudge` (or `/var/lib/nudge` as root), starts it as a systemd service, and prints the setup link. With Docker, `docker compose up -d` with [`packages/release/compose.yaml`](packages/release/compose.yaml) runs `ghcr.io/lum1n/nudge:stable` with its data in a volume; `docker compose logs` shows the setup link. The `-desktop` tags (`stable-desktop`, `<version>-desktop`) add what the desktop extension needs (D-Bus, AT-SPI, bubblewrap, LibreOffice Writer and Calc, about 400 MB); compose.yaml says what else it takes.

A server updates itself: every hour it looks for a newer release, installs one the project signed, and starts it. If the new one stops with an error before it has run for 30 seconds, `nudge-server` goes back to the one before and doesn't try it again. Owners see this at `GET /v1/server` and can turn it off (`PUT /v1/server/updates`).

Releases are made by pushing a tag such as `v0.2.0` ([`.github/workflows/release.yml`](.github/workflows/release.yml)): an archive per architecture from [`packages/release/scripts/bundle.sh`](packages/release/scripts/bundle.sh), a `manifest.json` signed with the `NUDGE_RELEASE_KEY` secret, and the image. Make that key once with `node packages/release/scripts/keygen.mjs`, and put its public half in `RELEASE_KEYS` (`packages/core/src/server/updates.ts`); until then servers don't update themselves.

## Run on Cloudflare

`packages/cloudflare` runs assistants as a Worker with one SQLite-backed Durable Object per assistant, with no machine to keep ([ADR 14](docs/adr/0014-durable-object-host.md)). Set the assistants in `NUDGE_CONFIG` in its `wrangler.jsonc`, as `nudge.json` has them but without databases or extensions, and deploy:

```bash
cd packages/cloudflare
pnpm wrangler secret put ANTHROPIC_API_KEY     # or another provider's key
pnpm wrangler secret put NUDGE_CLAIM_SECRET    # any long random string
pnpm run deploy
curl -X POST https://nudge.<you>.workers.dev/v1/a/nudge/claim \
  -H "Authorization: Bearer <the claim secret>" -d '{"displayName":"Ann"}'
```

The claim makes the first player, an admin, and prints their token, once; then sign in from the apps or `nudge chat --url` with it, and invite the others with pairing codes. Nudges fire on time through the object's alarm, also when it was idle. Extensions are code here: subclass `NudgeAssistant`, return them from `options()`, and export the subclass from your own Worker. Ones that need the host, such as the browser, desktop and terminal, don't run, and there are no backups, server API or web UI: those are a server's. `pnpm run dev` runs it locally.

## Use

From a checkout:

```bash
pnpm install && pnpm build
nudge serve     # not set up yet: prints a link with a one-time code for the setup wizard
nudge doctor    # checks Node, config, storage and credentials; --ping sends one request
nudge chat      # chat in this terminal; the conversation survives restarts
```

A server that isn't set up starts in setup mode: open the link it prints (or its QR code), and the wizard asks for a name for the assistant, a model with your Anthropic or OpenAI key (tried once before it is kept), or a model server it found on the machine such as Ollama, and your name. You become the assistant's first player and admin and the server's owner, the browser is signed in, and the assistant runs at once. The wizard ends with a QR code for your phone and a recovery kit. `nudge setup` asks the same in a terminal instead (`nudge init` is the same command). Ten wrong codes close setup until the server restarts.

The model key is kept encrypted on the server (`server/keys`), never shown again; a key in the environment, such as `ANTHROPIC_API_KEY`, still wins. Every database a server makes is encrypted under a key file of its own, and nightly backups are on, kept beside the data: copy them somewhere else too. The recovery kit is the backup key sealed with a passphrase; with it and a backup, `nudge restore <backup> --to <dir> --kit <kit>` brings the whole server back on another machine. `nudge kit` writes a new one.

The server's owners create, change and delete assistants and set model keys, over `/v1/server` (see the protocol). `nudge owner add <player>` makes another player an owner, `nudge owner add <address>` someone whose home is elsewhere, and `nudge owner token <player>` prints a server token for scripts. Set up from the app while signed in at home, a server is started from your home: its first player is you, by your address, and you are its owner. It is part of your cluster by default: its assistant gets federation, you join it from home, and your other devices list it. Turn that off and it stays standalone, with no federation, until you pick "Join my cluster" for it in Settings; its rooms and history stay. A server set up signed out is a home of its own, and never joins another person's cluster.

Nudge keeps its config, databases and keys in one data directory: `$NUDGE_HOME`, or else `~/.local/share/nudge` (`~/Library/Application Support/Nudge` on a Mac). A `nudge.json` in the directory you run `nudge` in is used instead, as in a checkout, and `-c <file>` picks any other. Without a config, commands other than `serve` and `setup` say so instead of starting a fresh assistant.

[`nudge.example.json`](nudge.example.json) shows every option: two assistants, one on Anthropic with an extension and its settings, and one on a local llama-server.

In `nudge chat`, `/steer <text>` joins the answer in progress, `/stop` or Ctrl-C stops it, `/who` lists who can read along, `/nudges` lists the room's scheduled nudges and `/nudges cancel <id>` cancels one, `/memory` lists what the assistant remembers in the room and `/memory add <text>` and `/memory forget <id>` change it, `/quit` leaves. `nudge chat me` opens your personal room; `nudge chat <room>` any other room you are in.

## Nudges

Ask the assistant to remind you of something ("remind me in 20 minutes to check the oven", "every morning at 8, ask me what I plan to do today") and it schedules a nudge with its `schedule_nudge` tool; `list_nudges` and `cancel_nudge` cover the rest. When a nudge is due, the assistant says it in the room it was set in, without anyone writing first. Times without an offset are read in the assistant's `timeZone`. Nudges survive restarts: one that fell due while the host was down fires when it starts again, and a repeating one then skips the repeats it missed. `nudge nudges` lists every pending nudge.

## Models

Anthropic is the default provider. Any provider [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) knows works by name, such as `{ "provider": "openai", "modelId": "gpt-5-mini" }`, `xai`, `google` or `openrouter`; each reads its key from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, …), and `nudge doctor` says whether it found one. Any OpenAI-compatible server works too:

```json
{
  "assistants": [{ "name": "robin", "model": { "provider": "local", "modelId": "qwen2.5-3b" } }],
  "providers": [
    {
      "id": "local",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "models": [{ "id": "qwen2.5-3b", "contextWindow": 8192 }]
    }
  ]
}
```

## Memory

Tell the assistant something worth keeping ("I'm vegetarian", "the trip starts on 3 May") and it can save it with its `remember` tool; `forget` drops a fact again. What a room remembers is in the assistant's prompt on every turn there, also after old messages have been summarized away. Memory belongs to the room it was made in: what you tell it in your personal room stays there, and a shared room's memory is seen only by its members. At most 100 facts per room.

You also have a memory of your own, for what matters wherever you are. In your personal room, ask the assistant to remember something everywhere, or add it in the web UI or with `POST /v1/a/<assistant>/me/memory`. Your own facts show in your personal room. They show in your other rooms, to the people there and to the model, only after you turn on sharing ("Share my own facts with all my rooms" in the Memory panel, or `PUT /me/memory/sharing`). Each fact records who remembered it.

## Several people

Each person is a player with their own token. Everyone shares the lobby; a personal room is for one player; a shared room is for the players it lists. The assistant knows who wrote each message and who can read the room.

```bash
nudge invite Ann                      # prints Ann's token, once
nudge invite Bo
nudge token ann                       # another token for Ann, such as for a lost one
nudge tokens ann                      # Ann's tokens by client id; revoke one with `nudge revoke <client>`
nudge pair bo                         # a one-time code, link and QR code that signs an app in as Bo
nudge admin bo                        # Bo may use the admin API too (the first player always may)
nudge room Trip --members ann,bo      # a shared room "trip"; `nudge room` lists them
nudge serve                           # web UI at http://127.0.0.1:8787, API under /v1
```

`nudge invite` also prints a sign-in link for the web UI (`/login#token=…`; pass `--port` or `--url` if the server isn't on 127.0.0.1:8787). The web UI keeps the token for the browser tab only, unless "Remember this device" is ticked at sign-in. `nudge serve --web <dir>` serves another build, `--web none` only the API.

Or each person connects from their own terminal, and all of them see the same conversation live:

```bash
NUDGE_TOKEN=nudge_… nudge chat trip --url http://127.0.0.1:8787 --assistant nudge
```

One process owns an assistant's database at a time. While `nudge serve` runs, the admin commands (`invite`, `pair`, `token`, `tokens`, `revoke`, `admin`, `room` and `nudges`) go through the server instead when given an admin's token (`--token` or `$NUDGE_TOKEN`, and `--url` if it isn't on 127.0.0.1:8787); `invite` then prints a pairing code rather than a token. A pairing code works once, for ten minutes. Pairing links carry the address of the request; behind a proxy, start `nudge serve --public-url https://…`. `serve` listens on 127.0.0.1, this computer only. For the apps on a phone, start `nudge serve --host 0.0.0.0` and sign in at `http://<the computer's address>:8787`, as `serve` prints it; that is plain HTTP, so keep to a network you trust, or put a TLS proxy (or a VPN) in front.

Every client, the web UI, `nudge chat --url` and the native apps, talks [protocol v1](docs/protocol/v1.md) under `/v1`: one WebSocket for live views and HTTP for commands, pairing and admin. `GET /v1/a` lists the assistants without a token. The types are in `@nudge/protocol`, and `@nudge/client` is the TypeScript client.

## Web UI

Sign in at `/login` by scanning its QR code with your phone's camera: the Nudge app, signed in already, asks to confirm and signs the browser in as you, at the assistant the app uses on that server. Or sign in with a token, the link `nudge invite` prints (`/login#token=…`, which never reaches the server or its logs), or a pairing code from `nudge pair`. The token lives in that browser tab's `sessionStorage` only, so opening another tab or browser needs its own sign-in, unless you tick **Remember this device**: then it is kept in the browser's `localStorage`, and every tab, and a notification opened after the tab closed, stays signed in until **Sign out**, which forgets it in both. Leave it unticked on a shared computer.

A room page shows the same conversation the CLI and the API see, live, for everyone in it: each message with who sent it, the assistant's answer streaming in with its tool calls, and fired nudges, rendered as markdown. Send a follow-up or steer while it's still answering — it queues the same way a second CLI client's would — or stop it; "Load earlier" fetches older history past what first loaded. A room's Memory, Nudges and approval panels list, add, forget, cancel and decide the same things `/memory`, `/nudges` and `/approve` do in the terminal, and update live whoever made the change. The web UI talks [protocol v1](docs/protocol/v1.md) through `@nudge/client`, like the native apps will. "Open my room" and "New shared room" on the room list open the same rooms `nudge chat me` and `nudge room` do.

Notifications come from the extension `extensions/push`, on each assistant that should send them:

```json
{
  "from": "./extensions/push",
  "settings": { "preview": "room", "subject": "mailto:you@example.com" }
}
```

"Turn on" under Notifications on the room list subscribes the browser to Web Push. Then answers, fired nudges and approvals in that player's rooms arrive as notifications, except for a room that is open in a visible tab. They need HTTPS, or `localhost`, and on an iPhone the site added to the home screen. Pushes are encrypted for the browser, so Google's, Mozilla's or Apple's push service only relays them. By default a notification says only which room has news; `"preview": "text"` adds the start of the text. The extension makes the server's push keys on first start, in `push-vapid.json` beside the database, shared by the assistants whose databases are there, since a browser has one subscription for the whole site; losing them means browsers must turn notifications on again. A room where someone turns the extension off with `/extensions` sends no pushes. When a browser renews its subscription by itself, the service worker hands the new one to the server without asking you.

The iOS, macOS and Android apps (`apps/apple`, `apps/android`) get the same notifications through APNs and FCM. The server sends them directly, so the extension needs credentials for them in its settings (paths absolute, or from the directory nudge runs in):

```json
"settings": {
  "apns": { "keyFile": "apns-key.p8", "keyId": "ABC123DEFG", "teamId": "XYZ987TEAM", "bundleId": "app.nudge.dev" },
  "fcm": { "serviceAccountFile": "firebase-service-account.json" }
}
```

The APNs key comes from the Apple Developer account (Keys, with Apple Push Notifications service); the FCM key is a service account of the Firebase project the Android app is built with (Project settings → Service accounts → Generate new private key). Without them the apps work, without notifications.

The published apps' APNs key and Firebase project are the project's, not yours, so a server reaches those apps through a push relay instead: list it in the extension's `"relays"`. An app registers its device with the relay and gets a handle, an encrypted form of its device token that only the relay can read. It gives each server it signs in to that handle and an X25519 key it made for itself. The server seals every push for that key (X25519, HKDF-SHA256, AES-256-GCM) and sends it to the relay with the handle. The relay opens the handle and passes the sealed push on, so the relay, Apple and Google see ciphertext and a hash of the room as the collapse id. The app decrypts it on the device: in a notification service extension on iOS and macOS, and as it arrives on Android. A relay keeps no list of devices and limits pushes per sender and per device.

`packages/relay` is the relay, run as `nudge-relay --config relay.json --port 8790` behind a TLS proxy:

```json
{
  "apns": {
    "keyFile": "AuthKey.p8",
    "keyId": "ABC123DEFG",
    "teamId": "XYZ987TEAM",
    "bundleId": "app.nudge"
  },
  "fcm": { "serviceAccountFile": "firebase-service-account.json" },
  "trustProxy": true
}
```

Paths are relative to `relay.json`. The relay makes `relay-handle.key` beside it on first start; losing it means every app registers again. Apps call `POST /v1/register { platform, token, environment? }` → `{ handle }`, and servers `POST /v1/send { handle, sealed, collapseId? }`: 204, 410 when the device is gone or the handle unknown, 429 past the limits (120 pushes a minute per sender, 30 per device, by default).

## Spend

Every model request's cost, as the model catalog prices it, is booked per month to the room and to the player whose message was being answered. That includes what tools such as the browser report. Nudges and watches count for the room only. `nudge usage` prints the months, by player and room, and `GET /v1/a/<assistant>/usage` gives the same to admins (others see the total and their own share).

`"budget": { "monthlyUsd": 20, "perPlayerUsd": 5, "warnAt": 0.8 }` on an assistant in `nudge.json` sets limits. At `warnAt` of a limit, the player, or for the assistant's limit the admins, hear about it in their own room, once a month. Past a player's limit their messages are refused. Past the assistant's, nothing more goes to the model, nudges and watches included, until the month ends (in the assistant's time zone). Local models cost nothing.

## Privacy

Nudge keeps what could do harm on its own from the model provider. Before a request leaves, it replaces these with placeholders such as `⟦EMAIL1⟧` or `⟦PHONE2⟧`:

- passwords, API keys, tokens and private keys
- Norwegian national identity numbers
- card numbers, IBANs and Norwegian account numbers
- e-mail addresses and phone numbers
- whatever someone makes private, and their personal details and location (below)

This covers every request, including tool rounds and the summaries made when a long conversation is compacted. Thinking that could hold a value is left out. A value keeps its placeholder for the life of the assistant. Tools still get the real values, so a mail goes to the real address.

Names, places, stations, organisations, addresses, hosts, plates and birth dates stay readable, so the assistant can plan a trip, call an API or tell people apart. Hide one yourself with `/private` ([ADR 15](docs/adr/0015-hide-only-what-is-critical.md)).

For more, a small model on the server hides names, places and organisations too, such as a vet's name on its own ("hos Vethjem"), along with the rules for hosts, plates and birth dates. It is off unless `nudge.json` has `"privacy": { "deep": "required" }`, which refuses requests until the model runs, or `"deep": "preferred"`, which sends them with the rules alone meanwhile. `"allow": ["Kiwi"]` keeps words it hides by mistake readable. Famous people, companies, brands and big cities abroad stay readable either way. The model is GLiNER (`urchade/gliner_multi-v2.1`, Apache-2.0), run on the CPU in a process of its own. It is downloaded the first time: about 260 MB, into `server/models` beside `nudge.json`. While it reads it takes about 650 MB of memory; after two minutes with nothing to read it stops. Assistants on Cloudflare run the rules alone ([ADR 14](docs/adr/0014-quasi-identifiers-and-local-ner.md)). Check what a room sends with **Model view**.

The history is stored with the placeholders too: messages, answers, tool results, memory, approvals and nudges. The values are kept in one place, the vault, and put back only where a person sees them (and where a tool acts on them, such as sending a mail). So forgetting a value takes it out of all history at once ([ADR 9](docs/adr/0009-placeholders-at-rest-and-per-person-visibility.md)). When the detectors learn more, the history is rewritten with them once, the next time the assistant opens.

In a shared room, you can keep things to yourself:

- **A value:** `/private <value>` in chat, or "Hide a value" in the web UI and the apps, keeps a value, such as an address, from the model and from everyone but you, wherever it shows. They see it as hidden. `/hidden` lists yours, and `/hidden forget <placeholder>` (or Forget) drops one for good, for everyone and the model.
- **A message:** `/whisper <text>`, or the Private switch by the message field, sends a message only you see, and the answer to it. The others see that you sent one. Approvals, nudges, facts and watches that answer makes are yours alone too. The assistant is told not to bring it up with the others; it may still, in its own words, so don't count on it for secrets from the model's memory.

Your personal details help the assistant fill in forms, write mail for you and find what is near you. Give your full name, e-mail, phone and address under **Personal details** on your profile (web and apps), and turn on **Share where I am** in the apps to tell it where you are while the app is open. Each value is yours alone in the vault: the model only ever gets placeholders for them, such as `⟦ADDRESS1⟧`, and only in your personal room and your private messages, so nobody else can have the assistant use them; tools get the real values when they act for you. They stay on your home assistant and don't travel with your profile. A new location replaces the last one, which is forgotten for good, and one within 100 m of it keeps its placeholder. In a shared room, the assistant knows where you are only after you turn on **Let the assistant know where I am** in the room's Location settings; then anyone there can ask it about what is near you, everyone in the room sees that you share it, and the place itself stays hidden from them and the model. Where the assistant knows someone's location, the room says so above the chat or under its name ([ADR 14](docs/adr/0014-personal-details-and-location.md)).

More:

- `nudge doctor --privacy` checks the detectors against sample data. `pnpm -C packages/core eval:privacy` measures what the rules and the local model hide, and what they hide that the model needed, on 256 test messages. With the local model on, `nudge doctor` checks its files and that it finds a name.
- `NUDGE_DEBUG_REQUESTS=1 nudge chat` (or `nudge serve`) writes every request, exactly as the provider receives it, to `<database>.requests.jsonl`.
- **Model view** on a room's page in the web UI (or `GET /rooms/<id>/model-view`) shows anyone in the room what its next request sends: the instructions and sections, every message and tool call, with placeholders where the values were.

`extensions/ner` adds names the lists don't have, such as relatives' (`extraNames`). `extensions/contacts` hides the whole names, e-mail addresses and phone numbers in your address books ([Contacts](#contacts), [ADR 16](docs/adr/0016-contacts-are-known-private-values.md)).

Display names of players are always protected. Images are passed through unchanged. Extensions keep their own data (connector notes, browser site notes, uploaded documents) as they stored it.

Each assistant keeps its data in one SQLite file, by default `data/<name>.sqlite` next to the config.

A database Nudge makes is encrypted from the start, under a key of its own in `<database>.key`, readable only by you. One from before that is not; to encrypt it, stop `nudge serve` and run `nudge db encrypt`. It encrypts the file in place (SQLite3 Multiple Ciphers) and writes its key file, or uses `NUDGE_DB_KEY` (32 random bytes, base64: `openssl rand -base64 32`) when that is set. With `NUDGE_DB_KEY` set, a new database is created encrypted. `nudge db` shows each database's state and `nudge db decrypt` undoes it. Like the other keys, this protects copies of the database and backups, not a host where someone can also read the key. Losing the key loses the data, so keep a copy of the key somewhere other than the database's backups.

### Backups

`nudge backup --to <dir>` writes one encrypted file with every assistant's database, its key file, the extensions' data (their secrets included), the push keys and `nudge.json`. It is safe while `nudge serve` runs: each database is copied as of one moment, and an encrypted one stays encrypted. With `"backup": { "dir": "/mnt/usb/nudge", "everyHours": 24, "keep": 14 }` in `nudge.json`, `nudge serve` makes one on its own every day and keeps the last 14. `nudge backup` alone then writes there too.

The backup key is `NUDGE_BACKUP_KEY` (32 random bytes, base64) or the file `nudge-backup.key` beside the config (`backup.keyFile` moves it). The first `nudge backup` makes the file if neither exists. That one key opens every backup, so keep a copy away from the machine and the backups.

To restore, unpack into an empty directory and start Nudge there: `nudge restore <file> --to <dir>`, then `nudge serve -c <dir>/nudge.json`. Every file is checked against its hash, and a wrong key or a damaged file is refused. For copies off the machine, point `dir` at a synced folder or a mounted share, or copy the files with rclone; they are encrypted already.

## Extensions

An extension adds tools, prompt sections, hooks, tasks and PII detectors to an assistant. List them per assistant in `nudge.json`; `from` is a file or package directory relative to the config, or an installed package name:

```json
{
  "assistants": [
    {
      "name": "robin",
      "extensions": [{ "from": "./extensions/hello", "settings": { "greeting": "Hei" } }]
    }
  ]
}
```

An entry's `rooms` lists the kinds of room it is on in by default (`"lobby"`, `"personal"`, `"shared"`; default all). Anyone in a room can turn an extension on or off there with `/extensions on|off|default <name>` in `nudge chat`, or `PUT /v1/a/<assistant>/rooms/<id>/extensions/<name>`; the built-in tools are always on.

`nudge doctor` loads them and checks their settings. After editing an extension or the list, `nudge reload` makes the running `nudge serve` (or an in-process `nudge chat`) install them again without a restart; if one fails, the old ones stay.

### Browse the web

`extensions/browser` gives the assistant a `browse` tool. The room's model hands it a task ("find a 2027 Mercedes GLC for sale in Oslo on finn.no"), and a browser agent on its own model works a real browser until it has the answer:

```json
{ "from": "./extensions/browser", "settings": { "model": "anthropic/claude-haiku-5-5" } }
```

- `model` is `provider/model` and defaults to `anthropic/claude-haiku-5-5`, which did best in our tests at a fraction of the cost of larger models. Without an Anthropic key, pick one from your provider, such as `openai/gpt-5-mini`. Weak models struggle with multi-step browsing.
- The model never sees the screen. It reads each page as compact text (open dialogs first, one line per search result) and acts on element refs, so any tool-calling model can drive it and every page passes through the same redaction as the rest of Nudge.
- The browser is headed, because many sites block headless ones, and runs on its own virtual display (needs `Xvfb`). Chromium is downloaded the first time a room browses, into `~/.cache/ms-playwright`. The server image has Xvfb and Chromium's libraries and releases bundle the extension, so a server made from the image can browse once it is turned on; one made from an image older than 0.3.0 can't, and says so. Each room keeps its own browser profile under `<database>.extensions/browser/profiles`, so cookies and consents stick; a room's browser closes after `idleMinutes` (default 10).
- It does not buy, book, send, sign up or enter your details on its own. When a task needs that, it gets everything ready, stops, and asks the room to approve the exact step ("Click \"Pay 1 290 kr\" on sas.no to book …"), as an approval like any other: in the chat, `/approve` in the terminal, and the apps. Approving it starts the browser agent again in the room's browser, where it left off, allowed to do exactly that step; the room then hears how it went. Deciding waits until that run is done. It logs in with your help: the first time a site needs a login, `browse` stops and asks you to open the room's **Browser** page in the web UI, a live view of that room's browser. Log in there yourself (password, BankID, a code, whatever the site asks) and press **Done**. With "Remember logins I type here" ticked, the username and password you typed are saved, and next time the agent's `browser_login` tool fills them in on that same host by itself. The model never sees them: password and one-time-code fields always read `[hidden]` in its view of a page, saved values are hidden wherever they appear, and the tools never return them.
- While `browse` runs, the chat and the terminal show what it is doing, one short line at a time (`Clicking "Search"…`).
- When `browse` stops for a login, the chat shows an **Open the room's browser to log in** button. The Browser page lists the room's saved logins (site and username, never the password) with a **Forget** button.
- Everyone in the room can open its browser. The first one in controls it; the others watch and can **Take control**.
- Saved logins are kept per room in `<database>.extensions/browser/logins/logins.enc`, encrypted (AES-256-GCM) under the key file next to it, both readable by their owner only, or under `NUDGE_BROWSER_KEY` (32 random bytes, base64) when you set it. The key protects copies of the database and backups; whoever has the key can read the logins.
- The browser does not reach localhost, private or link-local addresses, or `.local` names, so the agent cannot be steered into your router or other machines at home. Set `"allowPrivateNetwork": true` to allow it. Names that resolve to private addresses are not caught.
- **Site notes:** after a run that took a few actions, the browser agent writes short notes on how it used each site (where the filters are, URL parameters that worked, which button closes the cookie dialog), and gets them back the next time it reaches that site, in any room. They hold no results and nothing about the user, and cost one small extra request. `"siteNotes": false` turns them off.
- `nudge doctor` also checks the browser model's credentials.
- Install its browser once with `pnpm -C extensions/browser exec patchright install chromium`.
- `pnpm -C extensions/browser eval -- --model anthropic/claude-haiku-5-5,openai/gpt-5-mini` runs a set of everyday tasks against each model, twice each (`--runs 3` for more), through the same redaction as Nudge, after `pnpm build`. It writes each run's result, every request the providers got, and a summary table (answered, expected answer seen, steps, seconds, cost, leaks) to `extensions/browser/.eval/`. Some tasks carry made-up personal details; a leak is one of them reaching a request as it is, and makes the run exit with an error. Keys come only from your environment; without one for a model it stops before opening a browser.

### Use desktop apps

`extensions/desktop` gives the assistant a `use_desktop` tool, for apps with no better way in. The room's model hands it a task, and a desktop agent on its own model works the apps you list on a Linux desktop of the room's own:

```json
{
  "from": "./extensions/desktop",
  "settings": {
    "apps": {
      "writer": ["env", "SAL_USE_VCLPLUGIN=qt6", "libreoffice", "--writer"],
      "editor": ["gnome-text-editor"]
    }
  }
}
```

- Only the apps in `apps` can be started, by name: the program and its arguments. There is no shell. Left out, `apps` is the ones the server has of LibreOffice Writer and Calc (on their Qt backend), GNOME Text Editor and Dolphin; the server image has Writer and Calc.
- The model never sees the screen. It reads the windows as text from their accessibility tree (AT-SPI), open menus and dialogs first, and acts on element refs, so any tool-calling model can drive it and every window passes through the same redaction as the rest of Nudge. Password fields always read `[hidden]`.
- `model`, `reasoning`, `maxSteps` and `idleMinutes` work as for the browser; `model` defaults to `anthropic/claude-haiku-5-5`.
- Each room gets its own virtual display (`Xvfb`), session bus and accessibility bus, so nothing reaches your own desktop. The apps' home, with their settings and files, is `<database>.extensions/desktop/homes/conversation-<id>` and stays between tasks; the desktop and its apps close after `idleMinutes` (default 10), and when Nudge stops. The server needs `Xvfb`, `dbus-daemon` and `at-spi2-core`, and GTK, Qt or Chromium-based apps.
- It does not send, delete, pay, publish or save over a file on its own. It gets everything ready, stops, and asks the room to approve the exact step, as for the browser; approving it carries on on the same desktop.
- While `use_desktop` runs, the chat and the terminal show what it is doing (`Clicking "Save"…`).
- The room's desktop is live in the web app (the Desktop button in a room) and in the Android, iOS and macOS apps (About this room): the people in the room see its screen as it changes, and the one in control clicks and types into it, starts apps and brings windows to the front (there is no window manager); the others watch and can take control, as with the browser. The pictures go only to them, never to a model.
- Tried with GNOME Text Editor (GTK 4), LibreOffice Writer and Calc, Dolphin (Qt 6) and Firefox. LibreOffice has to run on its Qt backend, as above: on its GTK 3 backend it aborts when its windows are read. A spreadsheet reads as the cells on the screen that hold something; the agent moves around with the Name Box. Dolphin's inline rename field is invisible to it (it can still press F2 and type).
- The apps run in a bubblewrap sandbox (`sandbox`, on by default): they see the system's programs and libraries read-only, their desktop's home, display and buses, and nothing else of the machine: no other homes, not Nudge's data or config, and none of Nudge's environment (its keys). They keep the network. `readable` lists more directories they may read, such as where an app is unpacked outside `/usr` and `/opt`. The sandbox needs `bwrap` and user namespaces. Docker allows them only with seccomp, AppArmor and its masked `/proc` paths loosened (`security_opt` in [`packages/release/compose.yaml`](packages/release/compose.yaml), with the `stable-desktop` image); the other way is `sandbox` off, which runs the apps as the user Nudge runs as, able to read whatever it can, its data and keys included. `nudge doctor` says whether the sandbox works.
- `pnpm -C extensions/desktop eval -- --model anthropic/claude-haiku-5-5` runs a set of tasks in these apps (open and read files, write and save, count and rename files, read a page, and one that must stop to ask before deleting), each on a fresh desktop and home, and checks the answers and the files left behind (sandboxed, with the directory of `--apps`' file readable; `--no-sandbox` turns that off); otherwise it works as the browser eval, with its leak check, writing to `extensions/desktop/.eval/`. `--apps apps.json` says how to start apps that are installed elsewhere, as `{ "calc": ["env", "SAL_USE_VCLPLUGIN=qt6", "/opt/libreoffice/program/soffice", "--calc"] }`.

### Use the terminal

`extensions/terminal` gives the model a `run_command` tool: a bash command, run in a terminal of the room's own, for command-line tools such as `pandoc`, `ffmpeg`, `jq`, `git` or a quick Python script.

```json
{
  "from": "./extensions/terminal",
  "settings": { "network": false, "timeoutSeconds": 60, "desktopFiles": false }
}
```

- Every command runs in a bubblewrap sandbox. It sees the system's programs and libraries read-only, the room's workspace at `/workspace` (on the server `<database>.extensions/terminal/workspaces/conversation-<id>`, kept between commands), an empty `/tmp`, and nothing else of the machine: not your home, not Nudge's data or config, and none of Nudge's environment (its keys). It has its own processes, hostname and IPC. A command stops after `timeoutSeconds` (default 60, at most 600), and gets at most 512 processes and 1 GB per file it writes. The model gets the start and end of the output, past 30 000 characters, redacted like any tool's.
- It has no network unless `"network": true`. Then commands reach the internet through [slirp4netns](https://github.com/rootless-containers/slirp4netns), without this machine's own services (`127.0.0.1`, such as signal-cli's daemon) or the local network: private, link-local and CGNAT (Tailscale) addresses are blocked in the sandbox's network, and it has a DNS server of its own. That needs `slirp4netns`, `nsenter` and `ip` on the server (in the Docker image); commands with that network run as root of their own user namespace, without any capabilities. With `"localNetwork": true` as well, commands reach what the server reaches, the local network and this machine's services too, and slirp4netns isn't needed.
- Files move between the workspace and the room's documents (`extensions/documents`, when it is on in the room): `document_to_workspace` copies an uploaded document into `/workspace`, never over a file there, and `workspace_to_documents` adds a file from it to the room's documents, where people download it from the Documents page. Files of kinds the documents don't read, such as `.docx`, are kept without their text. Both go through the sandbox, so a link in the workspace leads nowhere a command couldn't go.
- With `"desktopFiles": true`, commands read and write the room's desktop's home (`extensions/desktop`, its apps' files) at `/desktop`, such as to convert with `pandoc` what Writer saved there.
- Each command is read before it runs, through pipes, `&&`, `$(…)`, `sh -c`, `xargs`, `find -exec` and wrappers like `env` or `timeout`:
  - Common tools that read, search, convert, build and fetch run at once.
  - Commands that delete files (`rm`, `find -delete`, `git clean`, `git reset --hard`), send data (`curl -d`, `curl -X POST`, `git push`, `ssh`, `scp`, mail), run a script of the workspace, run a program not on the list, or that it can't read for sure (a program named by a variable, `sh` reading its input) wait for someone in the room to approve that exact command, as an approval like any other. Approving it runs it, and the room hears the output.
  - `sudo`, `su`, `mount`, `docker`, `systemctl` and the like never run.
- `allow`, `ask` and `deny` add program names to those lists and override them; a program in `allow` runs however it is called.
- The reading covers shell commands, not the code a program runs: `python3 -c '…'` or a Node script can delete workspace files or, with the network, send them without asking. The sandbox is what keeps commands from the rest of the machine.
- `readable` lists more directories commands may read, such as where a tool is installed outside `/usr` and `/opt`.
- It needs `bwrap`, `bash` and user namespaces, like the desktop's sandbox; in Docker, the `security_opt` lines in [`packages/release/compose.yaml`](packages/release/compose.yaml). Without them it runs nothing, and `nudge doctor` says why.

### Coding agents

`extensions/acc` lets the assistant start, watch and steer the coding agents you run on your machines: Claude Code, Codex, Cursor, Copilot CLI, pi and opencode. It embeds [ACC](https://github.com/lum1n/acc), its core and its own SSH client, so nothing is installed on the machines and the server needs no `ssh`.

```json
{
  "from": "./extensions/acc",
  "settings": { "hosts": [{ "host": "192.168.1.20", "user": "me", "name": "devbox" }] }
}
```

- With nothing set up, it reaches the sessions on the machine Nudge runs on, as `local`, as the user Nudge runs as: those you started with the Sessh app or the `acc` CLI there, and the ones it starts. No SSH is involved; scripts run with `sh` and a login's environment, not Nudge's. Agents it starts there can read what that user can, Nudge's own data included; `"local": false` turns this off.
- Each other machine has a `host` and `port` (22) the server reaches it at, a `user`, and optionally a `name` to call it by (its address when left out). `rooms` limits which rooms may use it.
- The assistant logs in with a key of its own (`auth: "key"`, the default), made the first time and kept encrypted in the extension's secret store. Ask the assistant for its machines (`acc_hosts`) and it gives the line to add to `~/.ssh/authorized_keys` there. `auth: "agent"` uses the server's ssh-agent instead, and `auth: "password"` a `password` (`${NAME}` takes it from the environment).
- The first connection pins the machine's host key in `<database>.extensions/acc/hosts.json`. A machine that later shows another key is refused, and `nudge doctor` says so. After a reinstall, ask the assistant to trust the new key, which waits for an admin to approve it.
- `acc_start` starts an agent in a directory there with a first prompt, after someone in the room approves it (`approveStart`, default on). The agent runs detached on the machine and keeps running when Nudge restarts or the connection drops.
- The room that started a session follows it. Each permission request becomes an approval in the room: approving it lets the agent go ahead once, and denying it tells the agent no. When the agent finishes a turn, fails or exits, the room hears it with the agent's last message, like a watch. Questions the agent asks come to the room for the assistant to answer with `acc_answer`.
- `acc_sessions` lists the sessions on the machines, including ones started from elsewhere (the Sessh app, the `acc` CLI). `acc_follow` has a room follow one of them. `acc_read` shows a session's state and latest messages, commands and file changes. `acc_send`, `acc_answer` and `acc_control` (interrupt, stop, remove, compact, switch model) steer it.
- It needs ACC's Node binding. A release ships it in `acc-node/`. In a checkout, `pnpm acc:fetch` puts it in `.acc-node/`, from the ACC release `acc.sh` pins; with `ACC_SRC` set to an ACC checkout it builds it there instead (that needs cargo). `NUDGE_ACC_MODULE` points to another copy.
- Agent sessions you started by hand in a terminal aren't seen; ACC only knows the sessions it started.

### MCP servers

`extensions/mcp` gives the assistant the tools of [MCP](https://modelcontextprotocol.io) servers, started as programs or reached over HTTP:

```json
{
  "from": "./extensions/mcp",
  "settings": {
    "servers": {
      "github": {
        "command": "github-mcp-server",
        "args": ["stdio"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
      },
      "docs": {
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer ${DOCS_KEY}" }
      }
    }
  }
}
```

- Each tool becomes `mcp__<server>__<tool>`. They are not offered to the model up front: it finds the ones a task needs with `tool_search`, so a server with many tools doesn't fill the prompt.
- Calls to tools the server doesn't mark read-only wait for someone in the room to approve them, like the connectors' writes. Set a server's `approval` to `"always"` or `"never"` to change that, and `tools` to offer only some of its tools.
- `${NAME}` in `env` and `headers` comes from Nudge's environment, so keys stay out of `nudge.json`. A started program gets only those variables plus `PATH`, `HOME` and the locale, not Nudge's own keys.
- Results reach the model through the same redaction as everything else. Images in results are left out unless a server sets `"images": true`, since redaction only reads text.
- The tool lists are read when the extension is installed; `nudge reload` reads them again. A server that can't be reached then is left out and reported. Connections close after `idleMinutes` (default 5) unused, and on reload and shutdown.

Rooms can also add servers from the chat ("add the Linear MCP server, https://mcp.linear.app/mcp"):

- `add_mcp_server` asks the room to approve the exact URL or command line. A remote server needs anyone in the room; a program, which runs on the server as Nudge's user, needs an admin. A room's servers are its own, like its connectors.
- Keys never go in the chat. The assistant names the headers or variables a server needs, and people set them on the room's **MCP** page (web) or **MCP servers** in About this room (apps). A remote server that signs in with OAuth gets a **Sign in** button there: it opens the server's sign-in page, which comes back to this server's `/v1/a/<assistant>/ext/mcp/oauth/callback`, so the browser you sign in with must reach the server at the address your app uses. Keys and tokens are kept encrypted in the extension's secrets, and scrubbed from results.
- The assistant sees a room's servers in its prompt, lists their tools with `mcp_tools` and calls them with `mcp_call`. Calls to tools that aren't read-only wait for approval; the page can make a server ask before every call, or never.
- A started program gets only its variables plus `PATH`, `HOME` and the locale, and works in its own directory under the extension's data. It is not sandboxed.

### Web search

`extensions/search` gives the model `web_search`, through a [SearXNG](https://docs.searxng.org) instance of your own, and `read_page`, which reads one page as text without starting a browser. Set `url` to the instance (default `http://127.0.0.1:8888`) and turn on its JSON output (`search: formats: [html, json]` in its `settings.yml`); `language` picks the results' language. `read_page` only reads public addresses, also after a redirect, unless `readLocalPages` is on. A connector the room added for the task still comes first, and pages that need a login or clicking around are the browser's.

### News feeds

`extensions/rss` lets people add RSS and Atom feeds for the assistant to check first when they ask for the latest news. In a conversation, "follow NRK's feed" makes it call `add_feed` with the feed's address, or a site's, whose `<link rel="alternate">` names the feed; `list_feeds` and `remove_feed` cover the rest, and each conversation keeps its own (at most `maxPerRoom`, default 20). Feeds for every conversation, or some, go in the settings' `feeds`, each with a `name`, `url` and `rooms`. When a conversation has feeds, the assistant reads them with `read_feeds` (newest first, at most `maxItems` stories, optionally one feed or only stories with some words) before it searches the web. Like `read_page`, it only reads public addresses, also after a redirect, unless `readLocalFeeds` is on.

### Code mode

`extensions/codemode` gives the model one `codemode` tool: it writes a short JavaScript program that calls the room's tools as `tools.<name>(args)`, so it can loop, filter and combine their results in one step instead of one tool call per turn.

```json
{ "from": "./extensions/codemode", "settings": { "timeoutSeconds": 30 }, "rooms": [] }
```

- Scripts run in QuickJS inside a worker thread, with no network, files, environment or timers. They stop after `timeoutSeconds` (default 30, counting their tool calls) or when they use more than `memoryMb` (default 64).
- Every tool call a script makes goes through the room's normal tool handling: writes still wait for approval, and only the script's output reaches the model, redacted like any other tool result.
- `"models": true` also gives scripts classifiers and image generation, through the same redaction. It is off by default because each call is a paid request.
- `"rooms": []` installs it switched off everywhere, so rooms turn it on with `/extensions on codemode`.

### Connectors

`extensions/connectors` lets a room teach the assistant APIs of its own, such as a weather or timetable service. Nothing is built in. Ask in the chat ("add the MET weather API, use it for forecasts"); adding one waits for someone in the room to approve it. The model then prefers it over browsing for those tasks, and keeps notes on how to use it.

To make it always come first ("always use the timetable API first for departures"), turn on **Always use first** on the room's **Connectors** page, where you can also change what it is for, or use `/connector-first <id> on [what for]` in `nudge chat`. The model then calls it before browsing, searching, other tools or its own knowledge whenever a task matches, and falls back only when the call fails or doesn't have the answer. Asking for it in the chat works too, but the model only asks: turning it on or off, or changing what a first connector is for, waits for someone in the room to approve it.

- Reads (GET and HEAD) run at once. Anything else waits for approval, unless someone marked that call as a read, such as `POST /graphql`.
- Calls stay under the connector's base address. Localhost and the local network are blocked unless someone allows them for that connector.
- API keys, the local network and read paths are set by people, never by the model: on the room's **Connectors** page in the web UI, or with `/connectors` and `/connector-key <id>` in `nudge chat` (the key isn't echoed). Keys are stored encrypted and scrubbed from what the model sees.
- A connector belongs to the room it was added in. The owner can share one without a key with every room: `nudge connector share <id> [room]`, and `unshare` to move it back. `nudge connectors [room]` lists a room's.

### Mail

`extensions/mail` lets rooms search and read a mailbox over IMAP and send over SMTP. Accounts are set in the extension's settings, each with the rooms that may use it:

```json
{
  "from": "./extensions/mail",
  "settings": {
    "accounts": [
      {
        "id": "family",
        "from": "Family <family@example.org>",
        "imap": {
          "host": "imap.example.org",
          "user": "family@example.org",
          "password": "${FAMILY_MAIL_PASSWORD}"
        },
        "rooms": ["family"]
      }
    ]
  }
}
```

- The model gets `mail_search`, `mail_read` and `mail_send`. Reading opens the inbox read-only, so nothing is marked read. Sending, replies included (kept in their thread), waits for someone in the room to approve it.
- SMTP defaults to the IMAP host with `imap.` changed to `smtp.`, port 465 and the same login; give `smtp` to set it.
- `rooms` lists the rooms that may use the account, by id (`*` for every room). In Settings, on the web or in the apps, you pick them by name instead; `nudge room` lists the ids.
- Mail goes to the model like any tool output: e-mail addresses, phone numbers and the like as placeholders. Names are readable.
- Some servers don't keep a copy of sent mail in Sent by themselves.

### Calendar

`extensions/calendar` reads CalDAV calendars (Fastmail, iCloud, Nextcloud, Radicale, Google through its CalDAV address) and adds or removes events once someone approves. Accounts are set like mail's: `{ "id": "family", "url": "https://caldav.example.org", "user": "…", "password": "${FAMILY_CALDAV_PASSWORD}", "calendars": ["Family"], "rooms": ["family"] }`. Leave out `calendars` to use all of them.

- `calendar_events` lists a span of days, recurring events expanded and moved occurrences shown where they moved, in the assistant's time zone. `calendar_add` (a day without a time makes an all-day event) and `calendar_remove` (a whole series for a recurring event) wait for approval.
- For "remind us the evening before", the model schedules a nudge, say daily at 18:00, that looks at the next day's events.

### Contacts

`extensions/contacts` looks people up in CardDAV address books (Fastmail, iCloud, Nextcloud, Radicale, Google through its CardDAV address), so "send it to grandma" finds her address. Accounts are set like the calendar's: `{ "id": "family", "url": "https://carddav.example.org", "user": "…", "password": "${FAMILY_CARDDAV_PASSWORD}", "addressBooks": ["Family"], "rooms": ["family"] }`. Leave out `addressBooks` to use all of them.

- `contacts_search` finds people by name, nickname, relation as the contact is saved ("Mormor"), company, e-mail address or phone number, across every account the room may use, and gives their e-mail addresses, phone numbers, postal addresses and birthdays. It only reads; nothing in the address books changes.
- Every contact's e-mail addresses and phone numbers are hidden from the model wherever they show up, also a number written without spaces or without its country code (`91234567` for `+47 912 34 567`), which the built-in rules leave alone. So are whole names of two words or more, unless `hideNames` is `false`. Names of one word ("Mom") and companies' names stay readable, as do players' display names; a player who joins later gets theirs back readable ([ADR 16](docs/adr/0016-contacts-are-known-private-values.md)).
- The address books are read when the assistant opens and again when they are more than 15 minutes old. A value that showed up once stays hidden after its contact is gone.

### Watches

`extensions/watches` lets a room ask the assistant to keep an eye on something: "tell me when a 2027 GLC under 800 000 kr shows up on Finn", "when tomorrow's power price goes above 2 kr". The model adds a watch with `add_watch` (what to check, and how often), and `list_watches` and `remove_watch` show and stop them.

- Each check runs in a side conversation of the room, out of the room's sight but with its tools, connectors, logins and memory. The model replies with the items that match, each with a stable key such as its URL.
- The room hears only about items it hasn't seen before. That arrives like a fired nudge, so push and chat bridges deliver it too.
- Every check is a model run with tools, so it costs: `minMinutes` (default 30) caps how often, and `maxPerRoom` (default 10) how many.

### Triggers

`extensions/triggers` lets outside events start a turn. Watches can only check on a schedule. Ask "make a trigger for when the washing machine is done, and tell Ann" and the model calls `add_trigger` with a name and what to do. The room gets a secret web address, and calling it starts a turn. Good senders are a Home Assistant automation (`rest_command`), an Uptime Kuma webhook notification, a GitHub or Gitea webhook, a Paperless workflow, or an iPhone Shortcut ("Get contents of URL", method POST). `list_triggers` and `remove_trigger` show the triggers and turn them off.

- Senders `POST` to `/v1/a/<assistant>/ext/triggers/hook/<secret>`. A JSON, form or text body and any query parameters come along, so `curl -X POST -d 'Washer done' <address>` works. The answer is `202` straight away. The room hears the reply like a fired nudge, so push and the chat bridges deliver it too.
- Set `url` to the address senders reach the server at. Use the LAN or tailnet address for Home Assistant at home, and a public one for GitHub. Then the assistant gives the whole address. Without `url` it gives the part to put after the server's address.
- The model never sees the address. It gets a placeholder, and in the room only the person who asked sees the real address. The database keeps only the secret's hash; the secret sits in the extension's encrypted secret store so the address can be shown again. A wrong secret, a removed trigger and a room that turned the extension off all get the same `404`.
- What a call brings is untrusted: anyone with the address can send anything. The model gets it between two marked lines, with a random mark it can't fake, and is told to treat it as data, not instructions. The model reads at most `maxChars` (default 8000) of it. It passes redaction like any input. Actions that change things still wait for approval as always. This isn't proof against prompt injection, so give a trigger's room only the tools it needs.
- Every call is a model run, so it costs. `maxPerHour` (default 12) caps the calls per trigger; past that the sender gets `429` with `Retry-After`. `maxPerRoom` (default 10) caps how many triggers a room can have. A sender's retry with the same `Idempotency-Key` or `X-GitHub-Delivery` doesn't start a second turn.

### Lists

`extensions/lists` gives each room shared lists, such as shopping or packing. The model keeps them with `list_add`, `list_show`, `list_check`, `list_remove` and `list_clear`, and does not add an item twice. People see and change the same lists on the room's **Lists** page in the web UI, live: tick off, add, remove, clear what's done.

### Documents

`extensions/documents` keeps a room's receipts, warranties, contracts and letters. People upload them on the room's **Documents** page (PDF, text files, mail, images; 20 MB each by default) and download or delete them there. The model finds things in them with `search_documents` and `read_document`, and `list_documents` lists them.

- Text is read on the host: PDFs with pdf.js, text formats as they are. What the model gets of it passes through redaction like any tool output.
- Images and scanned PDFs without a text layer are kept but not read: reading them would mean sending the picture to a provider, which redaction can't cover.
- The original files are stored encrypted (AES-256-GCM) under the extension's data directory, with the key in its secret store. The text sits in the assistant's database.

### Telegram

`extensions/telegram` lets people talk to the assistant from Telegram. Make a bot with @BotFather, put its token in `TELEGRAM_BOT_TOKEN` (or set `token` in the extension's settings, `${NAME}` taking it from the environment), and install the extension. It long-polls Telegram, so the host needs no open port.

- **Link an account:** an admin runs `nudge pair <player>`, and the person sends `/link <code>` to the bot in a direct chat. The link is a token like any client's: `nudge tokens` lists it, and `nudge revoke <clientId>` unlinks Telegram.
- **Direct chats** talk to the player's own room. `/rooms` lists the others and `/room <id>` switches. In a group, a linked member picks the room with `/room <id>`; messages from people who aren't linked are ignored. For the bot to see ordinary group messages, turn off its privacy mode in @BotFather.
- **What comes back:** the room's answers, also those to fired nudges and to approvals, wherever they were asked. Approvals come with Approve and Deny buttons, which only members of the room can use. `/approve <id>`, `/deny <id>` and `/stop` work too.
- **Privacy:** what goes through the bot is readable by Telegram. Placeholders protect what the model sees, not what the chat service sees. Turn the extension off in rooms that shouldn't reach Telegram (`/extensions off telegram`).

### Signal

`extensions/signal` does the same over Signal, through a [signal-cli](https://github.com/AsamK/signal-cli) daemon on the host. Give the bot a number of its own, register or link it with signal-cli, and run `signal-cli -a +47… daemon --tcp 127.0.0.1:7583 --receive-mode=on-connection`, so messages wait on Signal's servers while Nudge isn't connected. The extension's `daemon` setting says where it listens; `account` picks the number when one daemon serves several. Linking, rooms and commands work as on Telegram. Signal has no buttons, so approvals say to send `/approve <id>` or `/deny <id>`. Messages are end-to-end encrypted up to the host, which is where they are decrypted.

### Matrix

`extensions/matrix` does the same as a Matrix bot account. Set `homeserver` in its settings and the account's access token in `MATRIX_ACCESS_TOKEN`. It joins rooms it is invited to, and a room with two members counts as a direct chat. It reads and writes rooms without end-to-end encryption only; encrypted messages are ignored. Like Signal, approvals ask for `/approve <id>` or `/deny <id>`.

The shared parts (links, chats to rooms, commands, relaying) live in `packages/bridge` for other chat services.

### Homes and other assistants

`extensions/federation` lets people from other Nudge assistants join this one, and people here join others (ADR 10). Everyone's home is the assistant they joined first; their address is their id there, the home's server and the assistant's name, such as `vegard@nudge.example.com/robin`. Set `server` to the address other servers reach this one at:

```json
{ "from": "./extensions/federation", "settings": { "server": "https://nudge.example.com" } }
```

An admin invites someone by address, `nudge invite ann@other.example/team`, which prints a `nudge://join` link that works for seven days. Their app asks their home to vouch for them (`POST /ext/federation/assert` there, with the assistant they join), and hands what the home signed to this one (`POST /ext/federation/join`), which checks it against the key the home publishes and answers with a token, as pairing does. They become a player here like anyone else, shown with their address. Their name, picture, time zone, language and settings come from their home, which sends them again whenever they change them there.

Their own memory goes along only where they turn it on (`PUT /ext/federation/memberships/memory` at home, `{ server, assistant, carry }`). The home then sends their own facts with the values behind the placeholders, and the other assistant protects those values in its own vault, so its model sees only placeholders of its own. Facts holding a value they made private, or remembered in a private turn, stay home. What they remember everywhere, or forget, on the other assistant goes home and comes back from there. Turned off, the facts that came from home are taken away there. `GET /ext/federation/memberships` at home lists where someone went.

In the Android and Apple apps, the account is the home: they read the memberships there on start and sign in to each assistant joined, also on a new phone, without another invite. Opening a `nudge://join` link joins, rooms are grouped by assistant, and Settings shows your address, where you joined (carrying your memory, leaving) and your profile. Admins invite people by address there and send them the link, and see the extensions and invites of every assistant they are an admin of, joined ones included. On the web, the Profile page shows your address and where you joined; joining takes an app, since another server's routes can't be called from this one's page. Someone who joined from elsewhere changes their profile at home: `PATCH /me/profile` answers 403 on the assistant they joined.

Everything between assistants is signed and encrypted: each assistant has an Ed25519 key to sign with and an X25519 key to be written to, kept with the extension's secrets and in backups. A message is signed by its sender, names who it is for, and is encrypted for that one assistant (X25519 with a key made for the message alone, HKDF-SHA256, AES-256-GCM), so the app that carries a join and any proxy on the way read nothing. Each assistant keeps the other's keys from the first time they met, over HTTPS, and takes messages only under those keys and only newer than the last of their kind. An admin rotates them with `POST /ext/federation/keys`: the old signing key signs for the new keys, `GET /ext/federation/key` lists the last eight rotations, and other assistants follow them the next time a message doesn't check out under the key they kept. Messages sealed to the old encryption keys still open. Rotating doesn't help against a leaked key, as whoever has it can sign for keys of their own. An assistant that loses its keys can no longer vouch for its people elsewhere.

### Assistants talking to each other

`extensions/peers` lets this assistant talk to assistants on other servers, such as to find a time with Ann's household or hand her assistant a request (ADR 16). It needs `extensions/federation` and uses its keys: everything between the two is signed and encrypted the same way.

```json
{ "from": "./extensions/peers", "settings": { "offer": ["calendar"] } }
```

- **Link first.** Someone asks in chat ("link with nudge.ann.no/robin"); the model calls `link_assistant`, and an admin here approves sending the request. Ann's admins get an approval in their lobby and decide. An admin can also `POST /ext/peers/links` with `{ address, note }`. `list_links` and `unlink_assistant` (admins) show and end links; `GET /ext/peers/links` and `DELETE /ext/peers/links/<id>` do it for apps.
- **A linked assistant is a guest.** Each side makes a player for the other ("Robin (assistant)"), with no token and no admin rights, and a shared room for it with the admins: "With Robin". Its messages arrive there as that player's, so redaction, the per-player budget and approvals work as for anyone, and the admins can read along. It can use only the extensions on in that room: `offer` picks them for a new link (none by default besides this one), and the room's own switches change them later.
- **Threads.** `talk_to_assistant` (a link, a goal, and what the other side needs to know) starts a thread in a side conversation of the room, out of its sight. The model there writes with `say`, reads each reply, and ends with `finish_thread`. The room hears how it went like a fired nudge, so push and chat bridges deliver it, and `show_thread` shows the whole conversation. On the other side, the answer to each message goes back; when its people approve something later, the answer to that follows up, also after the thread ended.
- **Privacy.** What goes out is shown as the other assistant's player may see it: values someone made private stay placeholders. The receiving side protects what arrives in its own vault. Messages from another assistant are marked as its words, not instructions, and a link's room and a thread can't start threads of their own.
- **Limits.** `maxRounds` (default 6) replies read per thread, `replyHours` (default 24) to wait for one, `maxThreadsPerHour` (default 10) threads each linked assistant may start here, `maxChars` (default 4000) per message. `onlyAdmins` keeps starting threads to admins.

### Write an extension

`extensions/hello/src/index.ts` is a whole one:

```ts
import { defineNudgeExtension, defineTool, regexDetector, section, Type } from "@nudge/core";

export default defineNudgeExtension({
  name: "hello",
  version: "0.1.0",
  settings: Type.Object({
    greeting: Type.String({ default: "Hello", minLength: 1 }),
    maxSides: Type.Integer({ default: 100, minimum: 2 }),
  }),
  setup: ({ settings, displayName }) => ({
    sections: [
      section(
        "greeting",
        () => `When someone greets ${displayName}, answer with "${settings.greeting}" first.`,
      ),
    ],
    tools: [
      defineTool({
        name: "roll_dice",
        description: "Roll dice; use it whenever someone asks for a random number or a dice roll.",
        parameters: Type.Object({ sides: Type.Optional(Type.Integer({ minimum: 2 })) }),
        execute: async ({ sides = 6 }) => ({
          output: [{ type: "text", text: String(1 + Math.floor(Math.random() * sides)) }],
        }),
      }),
    ],
    // Norwegian licence plates never reach the model.
    detectors: [regexDetector("PLATE", /(?<![\p{L}\p{N}])[A-Z]{2} ?\d{5}(?![\p{L}\p{N}])/u)],
  }),
});
```

- `setup` runs when the assistant opens and on every reload. It gets the settings (checked against the schema, defaults filled in), the assistant's `displayName`, `timeZone` and clock, `protect(value, kind)` to keep a value from the model and `release(value)` to make one readable again.
- `playerSettings` is a schema of what each player chooses for themselves, such as hello's default number of sides. Players set it on their profile, and `playerSettings(playerId, context)` in `setup`'s host reads it with defaults filled in; a tool finds who asked in `currentTurn().by`. Every required one needs a default, for players who chose nothing.
- `setup` can also return `routes`, HTTP routes under `/v1/a/<assistant>/ext/<name>/`. Each takes a standard `Request` and returns a `Response`, and says whether it needs a player's token (`auth: "player"`), an admin's (`"admin"`) or none (`"none"`); the server checks the token and the body's size (`maxBodyBytes`, default 64 KiB) first.
- It returns a [Pi Durable extension](https://www.npmjs.com/package/@earendil-works/pi-durable) without its name (`tools`, `sections`, `hooks`, `wraps`, `tasks`) plus `detectors`, which run after the built-in ones.
- Export it as `default` (or as `extension`). Plain Pi Durable extensions load too, without settings.
- Tool arguments arrive with personal values restored and tool output is redacted again before the model sees it, so tools work with real data.
- In code, pass extensions to `createNudge({ extensions: [hello, { extension: hello, settings }] })` and swap them with `nudge.reloadExtensions([...])`.

See ADR 0003 for why extensions look like this.

## Develop

Requires Node ≥ 22.19 and pnpm.

```bash
pnpm install
pnpm check   # typecheck, lint, test
pnpm build   # every package, and the web UI into apps/web/dist
```

`pnpm test` also runs `packages/cloudflare`'s tests, in workerd through `@cloudflare/vitest-plugin`.

The browser extension's tests on fixture pages (consent dialogs, hidden checkboxes, carousels, cards, logins) drive a real headless Chromium, so they run only when asked:

```bash
pnpm -C extensions/browser exec patchright install chromium
NUDGE_BROWSER_TESTS=1 pnpm exec vitest run extensions/browser
```

The desktop extension's tests on a real GTK app need `Xvfb`, `dbus-daemon`, `at-spi2-core` and python-gobject with GTK 3, so they run only when asked too:

```bash
NUDGE_DESKTOP_TESTS=1 pnpm exec vitest run extensions/desktop
```

The Rust client needs a Rust toolchain (edition 2024). Its tests start a server on a faux model with `node packages/server/scripts/faux-server.ts`, which runs the built packages, so `pnpm build` first:

```bash
cd clients/rust && cargo test
```

The Python package builds with [maturin](https://www.maturin.rs/) and runs the same server for its tests:

```bash
cd clients/python && uv venv && uv pip install maturin pytest
.venv/bin/maturin develop --uv && .venv/bin/python -m pytest
```

The Kotlin and Swift bindings run their tests on this machine too, against the host build of the library; see `clients/android` and `clients/apple` for building the apps' native libraries:

```bash
cd clients/android && ./gradlew :nudge:testDebugUnitTest -Pnudge.native=false
cd clients/apple && scripts/build.sh && swift test
```

The apps: `apps/android` builds with Gradle here (`./gradlew :app:installDebug`), and `apps/apple` on a Mac with Xcode; see their READMEs. `node packages/server/scripts/faux-server.ts` (after `pnpm build`) gives them a server on a fake model, with a pairing code.

For the web UI with hot reload, run `nudge serve` and then `pnpm -C apps/web dev`: Vite proxies `/v1` (HTTP and WebSocket) to `127.0.0.1:8787`, or to `$NUDGE_SERVER`.
