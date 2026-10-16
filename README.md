# Nudge

An extendable, multiplayer personal assistant that keeps personal data away from model providers. Lightweight, self-hostable, and embeddable as a library. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

> Early work in progress. Pi Durable is experimental and changes without notice, so Nudge pins exact versions.

## Packages

- `@nudge/core`: the embeddable library. One `Nudge` is one assistant: one storage, one Harness, one registry.
- `@nudge/server`: an HTTP and WebSocket API over one or more assistants.
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
- `@nudge/ext-mcp`: gives the assistant the tools of MCP servers (`extensions/mcp`).
- `@nudge/ext-codemode`: lets the model run short scripts that call the room's tools (`extensions/codemode`).

## Use

```bash
pnpm install && pnpm build
nudge init      # writes nudge.json
nudge doctor    # checks Node, config, storage and credentials; --ping sends one request
nudge chat      # chat in this terminal; the conversation survives restarts
```

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

One process owns an assistant's database at a time. While `nudge serve` runs, the admin commands (`invite`, `pair`, `token`, `tokens`, `revoke`, `admin`, `room` and `nudges`) go through the server instead when given an admin's token (`--token` or `$NUDGE_TOKEN`, and `--url` if it isn't on 127.0.0.1:8787); `invite` then prints a pairing code rather than a token. A pairing code works once, for ten minutes. Pairing links carry the address of the request; behind a proxy, start `nudge serve --public-url https://…`. `serve` listens on 127.0.0.1; put a TLS proxy in front before exposing it.

Every client, the web UI, `nudge chat --url` and the native apps, talks [protocol v1](docs/protocol/v1.md) under `/v1`: one WebSocket for live views and HTTP for commands, pairing and admin. `GET /v1/a` lists the assistants without a token. The types are in `@nudge/protocol`, and `@nudge/client` is the TypeScript client.

## Web UI

Sign in at `/login` with a token, the link `nudge invite` prints (`/login#token=…`, which never reaches the server or its logs), or a pairing code from `nudge pair`. The token lives in that browser tab's `sessionStorage` only, so opening another tab or browser needs its own sign-in, unless you tick **Remember this device**: then it is kept in the browser's `localStorage`, and every tab, and a notification opened after the tab closed, stays signed in until **Sign out**, which forgets it in both. Leave it unticked on a shared computer.

A room page shows the same conversation the CLI and the API see, live, for everyone in it: each message with who sent it, the assistant's answer streaming in with its tool calls, and fired nudges, rendered as markdown. Send a follow-up or steer while it's still answering — it queues the same way a second CLI client's would — or stop it; "Load earlier" fetches older history past what first loaded. A room's Memory, Nudges and approval panels list, add, forget, cancel and decide the same things `/memory`, `/nudges` and `/approve` do in the terminal, and update live whoever made the change. The web UI talks [protocol v1](docs/protocol/v1.md) through `@nudge/client`, like the native apps will. "Open my room" and "New shared room" on the room list open the same rooms `nudge chat me` and `nudge room` do.

Notifications: "Turn on" under Notifications on the room list subscribes the browser to Web Push. Then answers, fired nudges and approvals in that player's rooms arrive as notifications, except for a room that is open in a visible tab. They need HTTPS, or `localhost`, and on an iPhone the site added to the home screen. Pushes are encrypted for the browser, so Google's, Mozilla's or Apple's push service only relays them. By default a notification says only which room has news; `"push": { "preview": "text" }` in `nudge.json` adds the start of the text. `nudge serve` makes the server's push keys on first start (`push-vapid.json` beside the first assistant's database); losing them means browsers must turn notifications on again. When a browser renews its subscription by itself, the service worker hands the new one to the server without asking you.

The iOS, macOS and Android apps (`apps/apple`, `apps/android`) get the same notifications through APNs and FCM. The server sends them directly, so it needs credentials for them in `nudge.json` (paths relative to it):

```json
"push": {
  "apns": { "keyFile": "apns-key.p8", "keyId": "ABC123DEFG", "teamId": "XYZ987TEAM", "bundleId": "app.nudge.dev" },
  "fcm": { "serviceAccountFile": "firebase-service-account.json" }
}
```

The APNs key comes from the Apple Developer account (Keys, with Apple Push Notifications service); the FCM key is a service account of the Firebase project the Android app is built with (Project settings → Service accounts → Generate new private key). Without them the apps work, without notifications.

## Spend

Every model request's cost, as the model catalog prices it, is booked per month to the room and to the player whose message was being answered. That includes what tools such as the browser report. Nudges and watches count for the room only. `nudge usage` prints the months, by player and room, and `GET /v1/a/<assistant>/usage` gives the same to admins (others see the total and their own share).

`"budget": { "monthlyUsd": 20, "perPlayerUsd": 5, "warnAt": 0.8 }` on an assistant in `nudge.json` sets limits. At `warnAt` of a limit, the player, or for the assistant's limit the admins, hear about it in their own room, once a month. Past a player's limit their messages are refused. Past the assistant's, nothing more goes to the model, nudges and watches included, until the month ends (in the assistant's time zone). Local models cost nothing.

## Privacy

The model provider never sees personal data. Before a request leaves, Nudge replaces e-mail addresses, phone numbers, IBANs, card numbers, Norwegian national identity and account numbers, and the names of the people chatting with placeholders such as `⟦EMAIL1⟧`. This covers every request, including tool rounds and the summaries made when a long conversation is compacted. A value keeps its placeholder for the life of the assistant.

The history is stored with the placeholders too: messages, answers, tool results, memory, approvals and nudges. The values are kept in one place, the vault, and put back only where a person sees them (and where a tool acts on them, such as sending a mail). So forgetting a value takes it out of all history at once ([ADR 9](docs/adr/0009-placeholders-at-rest-and-per-person-visibility.md)). A database from before this needs `nudge db redact` once, with `nudge serve` stopped.

In a shared room, you can keep things to yourself:

- **A value:** `/private <value>` in chat, or "Hide a value" in the web UI and the apps, keeps a value, such as an address, from the model and from everyone but you, wherever it shows. They see it as hidden. `/hidden` lists yours, and `/hidden forget <placeholder>` (or Forget) drops one for good, for everyone and the model.
- **A message:** `/whisper <text>`, or the Private switch by the message field, sends a message only you see, and the answer to it. The others see that you sent one. Approvals, nudges, facts and watches that answer makes are yours alone too. The assistant is told not to bring it up with the others; it may still, in its own words, so don't count on it for secrets from the model's memory.

More:

- `nudge doctor --privacy` checks the detectors against sample data.
- `NUDGE_DEBUG_REQUESTS=1 nudge chat` (or `nudge serve`) writes every request, exactly as the provider receives it, to `<database>.requests.jsonl`.
- **Model view** on a room's page in the web UI (or `GET /rooms/<id>/model-view`) shows anyone in the room what its next request sends: the instructions and sections, every message and tool call, with placeholders where the values were.

`extensions/ner` is optional and finds more: people's names (common Norwegian and English given names, a capitalized family name after one, a known family name after a capitalized word, and the name after a greeting, sign-off or title such as "Mvh" or "Dr.") and Norwegian street addresses ("Storgata 5B, 0151 Oslo"). It uses name lists and rules on the host, no model. Words that are also names, like "Per" or "Liv", count at the start of a sentence only next to a family name. Town names on their own are left alone, so tools still know where things are. `extraNames` adds names the lists don't have, such as relatives'; `names` and `addresses` turn either part off. It will miss some names and catch some words that aren't names; check with **Model view**.

Display names of players are always protected. Images are passed through unchanged. Extensions keep their own data (connector notes, browser site notes, uploaded documents) as they stored it.

Each assistant keeps its data in one SQLite file, by default `data/<name>.sqlite` next to the config.

To encrypt that file, stop `nudge serve` and run `nudge db encrypt`. It encrypts the file in place (SQLite3 Multiple Ciphers) and writes a key to `<database>.key`, readable only by you, or uses `NUDGE_DB_KEY` (32 random bytes, base64: `openssl rand -base64 32`) when that is set. With `NUDGE_DB_KEY` set, a new database is created encrypted. `nudge db` shows each database's state and `nudge db decrypt` undoes it. Like the other keys, this protects copies of the database and backups, not a host where someone can also read the key. Losing the key loses the data, so keep a copy of the key somewhere other than the database's backups.

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
- The browser is headed, because many sites block headless ones, and runs on its own virtual display (needs `Xvfb`). Each room keeps its own browser profile under `<database>.extensions/browser/profiles`, so cookies and consents stick; a room's browser closes after `idleMinutes` (default 10).
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

### Web search

`extensions/search` gives the model `web_search`, through a [SearXNG](https://docs.searxng.org) instance of your own, and `read_page`, which reads one page as text without starting a browser. Set `url` to the instance (default `http://127.0.0.1:8888`) and turn on its JSON output (`search: formats: [html, json]` in its `settings.yml`); `language` picks the results' language. `read_page` only reads public addresses, also after a redirect, unless `readLocalPages` is on. A connector the room added for the task still comes first, and pages that need a login or clicking around are the browser's.

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
- Mail goes to the model like any tool output: addresses, phone numbers and the like as placeholders. Other names in a message are not detected.
- Some servers don't keep a copy of sent mail in Sent by themselves.

### Calendar

`extensions/calendar` reads CalDAV calendars (Fastmail, iCloud, Nextcloud, Radicale, Google through its CalDAV address) and adds or removes events once someone approves. Accounts are set like mail's: `{ "id": "family", "url": "https://caldav.example.org", "user": "…", "password": "${FAMILY_CALDAV_PASSWORD}", "calendars": ["Family"], "rooms": ["family"] }`. Leave out `calendars` to use all of them.

- `calendar_events` lists a span of days, recurring events expanded and moved occurrences shown where they moved, in the assistant's time zone. `calendar_add` (a day without a time makes an all-day event) and `calendar_remove` (a whole series for a recurring event) wait for approval.
- For "remind us the evening before", the model schedules a nudge, say daily at 18:00, that looks at the next day's events.

### Watches

`extensions/watches` lets a room ask the assistant to keep an eye on something: "tell me when a 2027 GLC under 800 000 kr shows up on Finn", "when tomorrow's power price goes above 2 kr". The model adds a watch with `add_watch` (what to check, and how often), and `list_watches` and `remove_watch` show and stop them.

- Each check runs in a side conversation of the room, out of the room's sight but with its tools, connectors, logins and memory. The model replies with the items that match, each with a stable key such as its URL.
- The room hears only about items it hasn't seen before. That arrives like a fired nudge, so push and chat bridges deliver it too.
- Every check is a model run with tools, so it costs: `minMinutes` (default 30) caps how often, and `maxPerRoom` (default 10) how many.

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

- `setup` runs when the assistant opens and on every reload. It gets the settings (checked against the schema, defaults filled in), the assistant's `displayName`, `timeZone` and clock, and `protect(value, kind)` to keep a value from the model.
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

The browser extension's tests on fixture pages (consent dialogs, hidden checkboxes, carousels, cards, logins) drive a real headless Chromium, so they run only when asked:

```bash
pnpm -C extensions/browser exec patchright install chromium
NUDGE_BROWSER_TESTS=1 pnpm exec vitest run extensions/browser
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
