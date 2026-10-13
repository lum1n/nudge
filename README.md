# Nudge

An extendable, multiplayer personal assistant that keeps personal data away from model providers. Lightweight, self-hostable, and embeddable as a library. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

> Early work in progress. Pi Durable is experimental and changes without notice, so Nudge pins exact versions.

## Packages

- `@nudge/core`: the embeddable library. One `Nudge` is one assistant: one storage, one Harness, one registry.
- `@nudge/server`: an HTTP and WebSocket API over one or more assistants.
- `@nudge/cli`: the `nudge` command.
- `@nudge/web`: the web UI (`apps/web`), served by `nudge serve`.
- `@nudge/ext-hello`: a sample extension (`extensions/hello`).

## Use

```bash
pnpm install && pnpm build
nudge init      # writes nudge.json
nudge doctor    # checks Node, config, storage and credentials; --ping sends one request
nudge chat      # chat in this terminal; the conversation survives restarts
```

In `nudge chat`, `/steer <text>` joins the answer in progress, `/stop` or Ctrl-C stops it, `/who` lists who can read along, `/nudges` lists the room's scheduled nudges and `/nudges cancel <id>` cancels one, `/memory` lists what the assistant remembers in the room and `/memory add <text>` and `/memory forget <id>` change it, `/quit` leaves. `nudge chat me` opens your personal room; `nudge chat <room>` any other room you are in.

## Nudges

Ask the assistant to remind you of something ("remind me in 20 minutes to check the oven", "every morning at 8, ask me what I plan to do today") and it schedules a nudge with its `schedule_nudge` tool; `list_nudges` and `cancel_nudge` cover the rest. When a nudge is due, the assistant says it in the room it was set in, without anyone writing first. Times without an offset are read in the assistant's `timeZone`. Nudges survive restarts: one that fell due while the host was down fires when it starts again, and a repeating one then skips the repeats it missed. `nudge nudges` lists every pending nudge.

Anthropic is the default provider and reads `ANTHROPIC_API_KEY`. Any OpenAI-compatible server works too:

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

## Several people

Each person is a player with their own token. Everyone shares the lobby; a personal room is for one player; a shared room is for the players it lists. The assistant knows who wrote each message and who can read the room.

```bash
nudge invite Ann                      # prints Ann's token, once
nudge invite Bo
nudge room Trip --members ann,bo      # a shared room "trip"; `nudge room` lists them
nudge serve                           # web UI at http://127.0.0.1:8787, API under /a/<assistant>
```

`nudge invite` also prints a sign-in link for the web UI (`/login#token=…`; pass `--port` or `--url` if the server isn't on 127.0.0.1:8787). The web UI keeps the token for the browser tab only. `nudge serve --web <dir>` serves another build, `--web none` only the API.

Or each person connects from their own terminal, and all of them see the same conversation live:

```bash
NUDGE_TOKEN=nudge_… nudge chat trip --url http://127.0.0.1:8787/a/nudge
```

One process owns an assistant's database at a time, so stop `nudge serve` before `nudge invite`, `nudge room` or `nudge nudges`. `serve` listens on 127.0.0.1; put a TLS proxy in front before exposing it.

`GET /a` lists the assistants without a token. The API, with `Authorization: Bearer <token>`, under `/a/<assistant>`: `GET /me`, `GET|POST /rooms`, `POST /rooms/personal`, `GET /rooms/<room>`, `POST /rooms/<room>/messages`, `POST /rooms/<room>/abort`, `GET /rooms/<room>/transcript`, `POST /protect`, `GET /nudges`, `DELETE /nudges/<id>`, `GET|POST /rooms/<room>/memory`, `DELETE /rooms/<room>/memory/<id>`. `GET /rooms/<room>/stream` is a WebSocket: send `{"type":"hello","token":…}` first, then get a snapshot and one batch of agent events per commit; send `submit` and `abort` frames. The types are in `packages/server/src/protocol.ts`.

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

`nudge doctor` loads them and checks their settings. After editing an extension or the list, `nudge reload` makes the running `nudge serve` (or an in-process `nudge chat`) install them again without a restart; if one fails, the old ones stay.

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

For the web UI with hot reload, run `nudge serve` and then `pnpm -C apps/web dev`: Vite proxies `/a` (HTTP and WebSocket) to `127.0.0.1:8787`, or to `$NUDGE_SERVER`.
