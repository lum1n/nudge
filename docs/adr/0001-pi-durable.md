# 1. Build on Pi Durable

Nudge needs durable conversations that survive crashes, several submitters per conversation, several attached clients, and typed state committed atomically with the transcript. `@earendil-works/pi-durable` provides all of these, so Nudge is a thin layer on top: identity, rooms, redaction, scheduled nudges, an extension loader, a host and a CLI.

Pi Durable is experimental and its API changes without notice. We pin exact versions of `pi-durable`, `pi-ai` and `chord`, and keep the public API of `@nudge/core` small, so an upgrade touches only `@nudge/core`.
