# Nudge

An extendable, multiplayer personal assistant that keeps personal data away from model providers. Lightweight, self-hostable, and embeddable as a library. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

> Early work in progress. Pi Durable is experimental and changes without notice, so Nudge pins exact versions.

## Packages

- `@nudge/core`: the embeddable library. One `Nudge` is one assistant: one storage, one Harness, one registry.
- `@nudge/server`: an HTTP and WebSocket API over one or more assistants.
- `@nudge/cli`: the `nudge` command.

## Use

```bash
pnpm install && pnpm build
nudge init      # writes nudge.json
nudge doctor    # checks Node, config, storage and credentials; --ping sends one request
nudge chat      # chat in this terminal; the conversation survives restarts
```

In `nudge chat`, `/steer <text>` joins the answer in progress, `/stop` or Ctrl-C stops it, `/who` lists who can read along, `/quit` leaves. `nudge chat me` opens your personal room; `nudge chat <room>` any other room you are in.

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

## Several people

Each person is a player with their own token. Everyone shares the lobby; a personal room is for one player; a shared room is for the players it lists. The assistant knows who wrote each message and who can read the room.

```bash
nudge invite Ann                      # prints Ann's token, once
nudge invite Bo
nudge room Trip --members ann,bo      # a shared room "trip"; `nudge room` lists them
nudge serve                           # http://127.0.0.1:8787/a/<assistant>
```

Then each person connects from their own terminal, and all of them see the same conversation live:

```bash
NUDGE_TOKEN=nudge_… nudge chat trip --url http://127.0.0.1:8787/a/nudge
```

One process owns an assistant's database at a time, so stop `nudge serve` before `nudge invite` or `nudge room`. `serve` listens on 127.0.0.1; put a TLS proxy in front before exposing it.

The API, with `Authorization: Bearer <token>`, under `/a/<assistant>`: `GET /me`, `GET|POST /rooms`, `POST /rooms/personal`, `GET /rooms/<room>`, `POST /rooms/<room>/messages`, `POST /rooms/<room>/abort`, `GET /rooms/<room>/transcript`, `POST /protect`. `GET /rooms/<room>/stream` is a WebSocket: send `{"type":"hello","token":…}` first, then get a snapshot and one batch of agent events per commit; send `submit` and `abort` frames. The types are in `packages/server/src/protocol.ts`.

## Privacy

The model provider never sees personal data. Before a request leaves, Nudge replaces e-mail addresses, phone numbers, IBANs, card numbers, Norwegian national identity and account numbers, and the names of the people chatting with placeholders such as `⟦EMAIL1⟧`; when the answer comes back, it puts the values back. This covers every request, including tool rounds and the summaries made when a long conversation is compacted. A value keeps its placeholder for the life of the assistant.

- `/private <value>` in chat (or `nudge.protect(value)` in code) keeps any other value from the model, such as an address.
- `nudge doctor --privacy` checks the detectors against sample data.
- `NUDGE_DEBUG_REQUESTS=1 nudge chat` (or `nudge serve`) writes every request, exactly as the provider receives it, to `<database>.requests.jsonl`.

Display names of players are always protected. The transcript and the placeholder vault are stored unredacted in the assistant's SQLite file on your host. Images and thinking blocks are passed through unchanged.

Each assistant keeps its data in one SQLite file, by default `data/<name>.sqlite` next to the config.

## Develop

Requires Node ≥ 22.19 and pnpm.

```bash
pnpm install
pnpm check   # typecheck, lint, test
```
