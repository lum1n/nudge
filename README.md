# Nudge

An extendable, multiplayer personal assistant that keeps personal data away from model providers. Lightweight, self-hostable, and embeddable as a library. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

> Early work in progress. Pi Durable is experimental and changes without notice, so Nudge pins exact versions.

## Quickstart

1. **Install a server** on a Linux machine (a home server, a Pi, a VPS):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/lum1n/nudge/main/packages/release/install.sh | sh
   ```

   It installs the newest release, starts it as a systemd service, and prints a setup link. Lost it? It is in `journalctl --user -u nudge` (`journalctl -u nudge` when installed as root). With Docker, see [Install a server](#install-a-server).

2. **Run the setup wizard:** open the link in a browser, using the machine's address instead of the one in the link from another device. It asks for a name for the assistant, a model (your Anthropic or OpenAI key, or a model server it found on the machine such as Ollama) and your name. You become the assistant's admin and the server's owner, and the assistant runs at once.

3. **Pair your phone:** the wizard ends with a QR code. Scan it with the Nudge app, or type its code into the app; it works once, for ten minutes. Then save the recovery kit it offers. For another device or person later, `nudge pair <player>` prints a new code, link and QR code ([Several people](#several-people)).

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
- `@nudge/ext-scripts`: saved scripts for lookups the assistant repeats, run again without a model (`extensions/scripts`).
- `@nudge/ext-federation`: lets people from other assistants join, with their home vouching for them (`extensions/federation`).
- `@nudge/ext-peers`: lets linked assistants on other servers talk to each other (`extensions/peers`).
- `@nudge/ext-places`: reminders when you get somewhere, with places the model sees as `⟦PLACE:home⟧` (`extensions/places`).
- `@nudge/ext-a2a`: talks with other AI agents over the A2A protocol, both ways (`extensions/a2a`).
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

A server updates itself from releases the project signed, and goes back to the one before if a new one isn't healthy. Errors go to stderr as JSON lines with personal values scrubbed, and `GET /v1/health` answers a monitor without a token. See [Running a server](docs/server.md) for updates, logs and how releases are made.

## Run on Cloudflare

`packages/cloudflare` runs assistants as a Worker with one SQLite-backed Durable Object per assistant, with no machine to keep ([ADR 21](docs/adr/0021-durable-object-host.md)). Set the assistants in `NUDGE_CONFIG` in its `wrangler.jsonc`, as `nudge.json` has them but without databases or extensions, and deploy:

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

**Dictate** in the composer types what you say, with the browser's own speech recognition (the Web Speech API, in Chrome, Edge and Safari), in your profile's language. That may send the audio to the browser's maker, so the first time on a device it asks. Profile shows this month's spend and your limits; admins see every month by person and room under Settings, and invite people from other assistants by their address there. Paste a join link into **Other assistants** in Profile to join from home: an assistant on the same server opens in the tab, one on another server's web UI gets the browser with your home's assertion in the address's fragment (`/join#…`).

The web UI speaks English and Norwegian (bokmål), following the browser's languages: any Norwegian (nb, nn, no) gets bokmål, anything else English. Its strings are in `apps/web/src/i18n`, one file per area and language; TypeScript fails when the bokmål file misses a key the English one has.

Notifications come from the extension `extensions/push`: Web Push in the browser, and APNs and FCM in the iOS, macOS and Android apps, either with your own credentials or through a push relay (`packages/relay`) that sees only sealed pushes. See [Notifications](docs/push.md).

## Spend

Every model request's cost, as the model catalog prices it, is booked per month to the room and to the player whose message was being answered. That includes what tools such as the browser report. Nudges and watches count for the room only. `nudge usage` prints the months, by player and room, and `GET /v1/a/<assistant>/usage` gives the same to admins (others see the total and their own share).

`"budget": { "monthlyUsd": 20, "perPlayerUsd": 5, "warnAt": 0.8 }` on an assistant in `nudge.json` sets limits. At `warnAt` of a limit, the player, or for the assistant's limit the admins, hear about it in their own room, once a month. Past a player's limit their messages are refused. Past the assistant's, nothing more goes to the model, nudges and watches included, until the month ends (in the assistant's time zone). Local models cost nothing. An assistant with no `monthlyUsd` refuses nothing, but its admins hear once a month when it has spent $25 (`warnUsd` changes that).

## Privacy

Nudge keeps what could do harm on its own from the model provider: passwords, keys and tokens, Norwegian national identity numbers, card and account numbers, e-mail addresses and phone numbers, whatever someone makes private, and people's personal details and location. Before a request leaves, it replaces these with placeholders such as `⟦EMAIL1⟧`, and the history is stored with the placeholders too, with the values in one vault; tools still get the real values, so a mail goes to the real address. Names, places and the like stay readable unless you hide one with `/private` or turn on the local model ([ADR 15](docs/adr/0015-hide-only-what-is-critical.md)). In a shared room, `/private <value>` and `/whisper <text>` keep things to yourself, and **Model view** on a room's page shows what its next request sends.

See [Privacy](docs/privacy.md) for what is hidden, the local model, private values and messages, personal details and location, and how to check what is sent.

## Data and backups

Each assistant keeps its data in one SQLite file, which Nudge encrypts under a key of its own. `nudge backup --to <dir>` writes one encrypted file with everything a server needs, safe while `nudge serve` runs; `"backup"` in `nudge.json` makes one every day, and `nudge restore <file> --to <dir>` brings it back. Copies can also go to an S3-compatible bucket or a WebDAV folder. Keep a copy of the keys away from the machine. See [Data and backups](docs/backups.md).

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

`extensions/browser` gives the assistant a `browse` tool. The room's model hands it a task, and a browser agent on its own model works a real browser until it has the answer. It reads pages as text through the same redaction as the rest of Nudge, logs in with your help from the room's **Browser** page, and stops for the room's approval before it pays, books, sends or signs up. See [Browse the web](docs/extensions/browser.md).

### Use desktop apps

`extensions/desktop` gives the assistant a `use_desktop` tool, for apps with no better way in. A desktop agent on its own model works the apps you list on a Linux desktop of the room's own, reading windows as text through their accessibility tree, in a bubblewrap sandbox, and stops for approval before it sends, deletes, pays or publishes. See [Use desktop apps](docs/extensions/desktop.md).

### Use the terminal

`extensions/terminal` gives the model a `run_command` tool: a bash command, run in a sandboxed terminal of the room's own, for command-line tools such as `pandoc`, `ffmpeg`, `jq`, `git` or a quick Python script. It has no network unless turned on, and commands that delete files or send data wait for approval. See [Use the terminal](docs/extensions/terminal.md).

### Coding agents

`extensions/acc` lets the assistant start, watch and steer the coding agents you run on your machines: Claude Code, Codex, Cursor, Copilot CLI, pi and opencode. It embeds [ACC](https://github.com/lum1n/acc), its core and its own SSH client, so nothing is installed on the machines and the server needs no `ssh`. See [Coding agents](docs/extensions/acc.md).

### MCP servers

`extensions/mcp` gives the assistant the tools of [MCP](https://modelcontextprotocol.io) servers, started as programs (in a sandbox) or reached over HTTP. Calls wait for approval unless you trust a server's read-only marks, images in results are left out unless a server says otherwise, and rooms can add servers of their own from the chat. See [MCP servers](docs/extensions/mcp.md).

### Web search

`extensions/search` gives the model `web_search`, through a [SearXNG](https://docs.searxng.org) instance of your own, and `read_page`, which reads one page as text without starting a browser. Set `url` to the instance (default `http://127.0.0.1:8888`) and turn on its JSON output (`search: formats: [html, json]` in its `settings.yml`); `language` picks the results' language. `read_page` only reads public addresses, also after a redirect, unless `readLocalPages` is on. A connector the room added for the task still comes first, and pages that need a login or clicking around are the browser's. Once a turn has read outside text, `read_page` asks the room first before it opens an address that nobody in the conversation named and no search of that turn found, since the address could carry the conversation away ([ADR 20](docs/adr/0020-untrusted-content-and-outbound-calls.md)).

### News feeds

`extensions/rss` lets people add RSS and Atom feeds for the assistant to check first when they ask for the latest news. In a conversation, "follow NRK's feed" makes it call `add_feed` with the feed's address, or a site's, whose `<link rel="alternate">` names the feed; `list_feeds` and `remove_feed` cover the rest, and each conversation keeps its own (at most `maxPerRoom`, default 20). Feeds for every conversation, or some, go in the settings' `feeds`, each with a `name`, `url` and `rooms`. When a conversation has feeds, the assistant reads them with `read_feeds` (newest first, at most `maxItems` stories, optionally one feed or only stories with some words) before it searches the web. Like `read_page`, it only reads public addresses, also after a redirect, unless `readLocalFeeds` is on.

### Code mode

`extensions/codemode` gives the model one `codemode` tool: it writes a short JavaScript program that calls the room's tools as `tools.<name>(args)`, so it can loop, filter and combine their results in one step instead of one tool call per turn. Scripts run in QuickJS with no network, files or environment. See [Code mode](docs/extensions/codemode.md).

### Connectors

`extensions/connectors` lets a room teach the assistant APIs of its own, such as a weather or timetable service. Ask in the chat; adding one waits for approval, reads run at once and anything else waits for approval, and keys are set by people on the room's **Connectors** page, never by the model. See [Connectors](docs/extensions/connectors.md).

### Mail

`extensions/mail` lets rooms search and read a mailbox over IMAP and send over SMTP. Accounts are set in the extension's settings, each with the rooms that may use it; sending waits for approval. See [Mail](docs/extensions/mail.md).

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

`extensions/watches` lets a room ask the assistant to keep an eye on something: "tell me when a 2027 GLC under 800 000 kr shows up on Finn". Each check runs in a side conversation of the room, and the room hears only about items it hasn't seen before. See [Watches](docs/extensions/watches.md).

### Scripts

`extensions/scripts` lets the assistant write the steps of a lookup it repeats once, as a short JavaScript program, and run it again by name without a model. Scripts only read, and a watch can run one for each check. See [Scripts](docs/extensions/scripts.md).

### Triggers

`extensions/triggers` lets outside events start a turn: the room gets a secret web address, and calling it (from Home Assistant, a webhook, an iPhone Shortcut) starts a turn. What a call brings is treated as untrusted data. See [Triggers](docs/extensions/triggers.md).

### Places

`extensions/places` reminds people when they get somewhere, or leave ("when I get home, remind me to water the plants"), and finds addresses and routes on the server's own map. The model only ever sees a saved place as `⟦PLACE:home⟧`. See [Places](docs/extensions/places.md).

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

`extensions/federation` lets people from other Nudge assistants join this one, and people here join others (ADR 10). Everyone's home is the assistant they joined first, and their address is their id there, such as `vegard@nudge.example.com/robin`. Everything between assistants is signed and encrypted. See [Homes and other assistants](docs/extensions/federation.md).

### Assistants talking to each other

`extensions/peers` lets this assistant talk to assistants on other servers, such as to find a time with Ann's household or hand her assistant a request (ADR 23). Both sides' admins link them first; a linked assistant is a guest in a shared room with the admins, and talks in threads. See [Assistants talking to each other](docs/extensions/peers.md).

### Other AI agents (A2A)

`extensions/a2a` talks with any agent that speaks [A2A](https://a2a-protocol.org) 1.0, the open Agent2Agent protocol, such as agents built with Google's ADK, LangGraph or a company's own (ADR 25). It needs no federation, and it can sit beside `extensions/peers`: peers links Nudge assistants with signed, encrypted messages; A2A reaches everyone else, over HTTPS (or Wired) with bearer tokens.

```json
{
  "from": "./extensions/a2a",
  "settings": { "server": "https://nudge.example.com", "offer": ["calendar"] }
}
```

- **Agents calling this assistant.** An admin lets one in on the settings page (or `POST /ext/a2a/clients` with `{ name }`), which shows its token once; only its hash is kept. The agent reads the Agent Card at `/v1/a/<assistant>/ext/a2a/.well-known/agent-card.json` and calls the JSON-RPC address it names with `Authorization: Bearer <token>`. Like a linked assistant, it is a guest: a player of its own ("Planner (agent)") in a shared room with the admins, "With Planner", where only what `offer` turns on is on. Each message is a task, answered there as its player's: a blocking call waits up to `waitSeconds`, then `GetTask` or a push notification has the answer. When the answer waits on an approval, the task stays working until the room's people decide, and then completes with what came of it. `SendMessage`, `GetTask`, `ListTasks`, `CancelTask` and push notification configs work; streaming doesn't. An admin removes a client on the settings page, or with `remove_agent`, and its token stops working.
- **This assistant calling agents.** An admin adds one by its address on the settings page, with a token if it needs one, kept in the extension's secrets (or `POST /ext/a2a/agents` with `{ url, token? }`). In chat, `add_agent` asks an admin to approve adding one; its token is set on the settings page, never in chat. `message_agent` sends a message and returns the answer, marked as the agent's words. One that takes longer than `waitSeconds` goes on in the background: the agent pushes to `server` when it can, and the assistant checks every `pollMinutes` for up to `replyHours`, and the room hears how it went like a fired nudge. Answers name their conversation, so the model goes on in it, also when the agent asks for more. `list_agents` lists both kinds.
- **Privacy and limits.** What goes out is shown as whoever asked may see it; values others made private stay placeholders. Rooms of agents that call in can't message agents, so agents don't chain on their own. `maxMessagesPerHour` (default 30) per calling agent, `maxChars` (default 8000) per message, and `onlyAdmins` keeps messaging agents to admins.

### Write an extension

An extension is a module that default-exports `defineNudgeExtension({ name, version, settings, setup })`; `setup` returns tools, prompt sections, hooks, tasks, routes and PII detectors. `extensions/hello` is a whole one. See [Write an extension](docs/extensions/writing.md).

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
