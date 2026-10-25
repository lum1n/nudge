# 1. Build on Pi Durable

Nudge needs durable conversations that survive crashes, several submitters per conversation, several attached clients, and typed state committed atomically with the transcript. `@earendil-works/pi-durable` provides all of these, so Nudge is a thin layer on top: identity, rooms, redaction, scheduled nudges, an extension loader, a host and a CLI.

Pi Durable is experimental and its API changes without notice. We pin exact versions of the Pi packages (`pi-durable`, `pi-ai`, `chord`, `pi-mcp`, `pi-codemode`), and only `@nudge/core` depends on them, so an upgrade touches only `@nudge/core`.

Extensions, the server, the CLI and the other packages take what they need from Pi through `@nudge/core`: documents and tasks (`defineDoc`, `defineDocFamily`, `defineTask`, `Tx`, `ToolRegistration`, …), contexts (`Context`, `BACKGROUND_CONTEXT`), model types (`Model`, `ModelContext`, …), code mode and tool search. Pi's model-facing `Context` is re-exported as `ModelContext`, beside Chord's `Context`. A few entry points keep what most code doesn't need out of the main one:

- `@nudge/core/testing`: the faux model provider and `createModels`, for tests.
- `@nudge/core/mcp`: Pi's MCP client, for the mcp extension.
- `@nudge/core/codemode`: Pi's code mode sandbox, for the codemode extension.
- `@nudge/core/cloudflare`: Pi Durable's Durable Object storage, for `@nudge/cloudflare`.

A package that needs something new from Pi adds the re-export to `@nudge/core` rather than a Pi dependency of its own. An exported document or task names its type from `@nudge/core` (`SessionDocToken`, `SessionDocFamilyToken`, `Task`), so built declarations don't refer to a Pi package either. A test in `@nudge/core` fails when any other package imports or depends on a Pi package.
