# Nudge

An extendable, multiplayer personal assistant that keeps personal data away from model providers. Lightweight, self-hostable, and embeddable as a library. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

> Early work in progress. Pi Durable is experimental and changes without notice, so Nudge pins exact versions.

## Packages

- `@nudge/core`: the embeddable library. One `Nudge` is one assistant: one storage, one Harness, one registry.
- `@nudge/cli`: the `nudge` command.

## Use

```bash
pnpm install && pnpm build
nudge init      # writes nudge.json
nudge doctor    # checks Node, config, storage and credentials; --ping sends one request
nudge chat      # chat in this terminal; the conversation survives restarts
```

In `nudge chat`, `/steer <text>` joins the answer in progress, `/stop` or Ctrl-C stops it, `/quit` leaves.

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

Each assistant keeps its data in one SQLite file, by default `data/<name>.sqlite` next to the config.

## Develop

Requires Node ≥ 22.19 and pnpm.

```bash
pnpm install
pnpm check   # typecheck, lint, test
```
