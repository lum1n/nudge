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
- `clients/android`: the Android library (Kotlin, `StateFlow`s) and a Compose sample app.
- `clients/apple`: the Swift package (`@Observable` models) for iOS and macOS.
- `@nudge/cli`: the `nudge` command.
- `@nudge/web`: the web UI (`apps/web`), served by `nudge serve`.
- `@nudge/ext-hello`: a sample extension (`extensions/hello`).
- `@nudge/ext-browser`: lets the assistant use the web (`extensions/browser`).
- `@nudge/ext-mcp`: gives the assistant the tools of MCP servers (`extensions/mcp`).

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

`nudge invite` also prints a sign-in link for the web UI (`/login#token=…`; pass `--port` or `--url` if the server isn't on 127.0.0.1:8787). The web UI keeps the token for the browser tab only. `nudge serve --web <dir>` serves another build, `--web none` only the API.

Or each person connects from their own terminal, and all of them see the same conversation live:

```bash
NUDGE_TOKEN=nudge_… nudge chat trip --url http://127.0.0.1:8787 --assistant nudge
```

One process owns an assistant's database at a time. While `nudge serve` runs, the admin commands (`invite`, `pair`, `token`, `tokens`, `revoke`, `admin`, `room` and `nudges`) go through the server instead when given an admin's token (`--token` or `$NUDGE_TOKEN`, and `--url` if it isn't on 127.0.0.1:8787); `invite` then prints a pairing code rather than a token. A pairing code works once, for ten minutes. Pairing links carry the address of the request; behind a proxy, start `nudge serve --public-url https://…`. `serve` listens on 127.0.0.1; put a TLS proxy in front before exposing it.

Every client, the web UI, `nudge chat --url` and the native apps, talks [protocol v1](docs/protocol/v1.md) under `/v1`: one WebSocket for live views and HTTP for commands, pairing and admin. `GET /v1/a` lists the assistants without a token. The types are in `@nudge/protocol`, and `@nudge/client` is the TypeScript client.

## Web UI

Sign in at `/login` with a token, the link `nudge invite` prints (`/login#token=…`, which never reaches the server or its logs), or a pairing code from `nudge pair`. The token lives in that browser tab's `sessionStorage` only; opening another tab or browser needs its own sign-in.

A room page shows the same conversation the CLI and the API see, live, for everyone in it: each message with who sent it, the assistant's answer streaming in with its tool calls, and fired nudges, rendered as markdown. Send a follow-up or steer while it's still answering — it queues the same way a second CLI client's would — or stop it; "Load earlier" fetches older history past what first loaded. A room's Memory, Nudges and approval panels list, add, forget, cancel and decide the same things `/memory`, `/nudges` and `/approve` do in the terminal, and update live whoever made the change. The web UI talks [protocol v1](docs/protocol/v1.md) through `@nudge/client`, like the native apps will. "Open my room" and "New shared room" on the room list open the same rooms `nudge chat me` and `nudge room` do.

No mobile app or notifications: a fired nudge only shows up in a tab that already has that room open.

## Privacy

The model provider never sees personal data. Before a request leaves, Nudge replaces e-mail addresses, phone numbers, IBANs, card numbers, Norwegian national identity and account numbers, and the names of the people chatting with placeholders such as `⟦EMAIL1⟧`; when the answer comes back, it puts the values back. This covers every request, including tool rounds and the summaries made when a long conversation is compacted. A value keeps its placeholder for the life of the assistant.

- `/private <value>` in chat (or `nudge.protect(value)` in code) keeps any other value from the model, such as an address.
- `nudge doctor --privacy` checks the detectors against sample data.
- `NUDGE_DEBUG_REQUESTS=1 nudge chat` (or `nudge serve`) writes every request, exactly as the provider receives it, to `<database>.requests.jsonl`.

Display names of players are always protected. The transcript and the placeholder vault are stored unredacted in the assistant's SQLite file on your host. Images and thinking blocks are passed through unchanged.

Each assistant keeps its data in one SQLite file, by default `data/<name>.sqlite` next to the config.

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
- It does not buy or send messages. It logs in with your help: the first time a site needs a login, `browse` stops and asks you to open the room's **Browser** page in the web UI, a live view of that room's browser. Log in there yourself (password, BankID, a code, whatever the site asks) and press **Done**. With "Remember logins I type here" ticked, the username and password you typed are saved, and next time the agent's `browser_login` tool fills them in on that same host by itself. The model never sees them: password and one-time-code fields always read `[hidden]` in its view of a page, saved values are hidden wherever they appear, and the tools never return them.
- When `browse` stops for a login, the chat shows an **Open the room's browser to log in** button. The Browser page lists the room's saved logins (site and username, never the password) with a **Forget** button.
- Everyone in the room can open its browser. The first one in controls it; the others watch and can **Take control**.
- Saved logins are kept per room in `<database>.extensions/browser/logins/logins.enc`, encrypted (AES-256-GCM) under the key file next to it, both readable by their owner only, or under `NUDGE_BROWSER_KEY` (32 random bytes, base64) when you set it. The key protects copies of the database and backups; whoever has the key can read the logins.
- The browser does not reach localhost, private or link-local addresses, or `.local` names, so the agent cannot be steered into your router or other machines at home. Set `"allowPrivateNetwork": true` to allow it. Names that resolve to private addresses are not caught.
- `nudge doctor` also checks the browser model's credentials.
- Install its browser once with `pnpm -C extensions/browser exec patchright install chromium`.
- `pnpm -C extensions/browser eval -- --model anthropic/claude-haiku-5-5,openai/gpt-5-mini` runs a set of everyday tasks against each model and writes results to `extensions/browser/.eval/`. Keys come only from your environment.

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

### Connectors

`extensions/connectors` lets a room teach the assistant APIs of its own, such as a weather or timetable service. Nothing is built in. Ask in the chat ("add the MET weather API, use it for forecasts"); adding one waits for someone in the room to approve it. The model then prefers it over browsing for those tasks, and keeps notes on how to use it.

- Reads (GET and HEAD) run at once. Anything else waits for approval, unless someone marked that call as a read, such as `POST /graphql`.
- Calls stay under the connector's base address. Localhost and the local network are blocked unless someone allows them for that connector.
- API keys, the local network and read paths are set by people, never by the model: on the room's **Connectors** page in the web UI, or with `/connectors` and `/connector-key <id>` in `nudge chat` (the key isn't echoed). Keys are stored encrypted and scrubbed from what the model sees.
- A connector belongs to the room it was added in. The owner can share one without a key with every room: `nudge connector share <id> [room]`, and `unshare` to move it back. `nudge connectors [room]` lists a room's.

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

For the web UI with hot reload, run `nudge serve` and then `pnpm -C apps/web dev`: Vite proxies `/v1` (HTTP and WebSocket) to `127.0.0.1:8787`, or to `$NUDGE_SERVER`.
