# Connectors

`extensions/connectors` lets a room teach the assistant APIs of its own, such as a weather or timetable service. Nothing is built in. Ask in the chat ("add the MET weather API, use it for forecasts"); adding one waits for someone in the room to approve it. The model then prefers it over browsing for those tasks, and keeps notes on how to use it.

To make it always come first ("always use the timetable API first for departures"), turn on **Always use first** on the room's **Connectors** page, where you can also change what it is for, or use `/connector-first <id> on [what for]` in `nudge chat`. The model then calls it before browsing, searching, other tools or its own knowledge whenever a task matches, and falls back only when the call fails or doesn't have the answer. Asking for it in the chat works too, but the model only asks: turning it on or off, or changing what a first connector is for, waits for someone in the room to approve it.

- Reads (GET and HEAD) run at once. Anything else waits for approval, unless someone marked that call as a read, such as `POST /graphql`. A read that sends a query or body waits too once the turn has read outside text, the answer of an API included ([ADR 20](../adr/0020-untrusted-content-and-outbound-calls.md)).
- Calls stay under the connector's base address. Localhost and the local network are blocked unless someone allows them for that connector.
- API keys, the local network and read paths are set by people, never by the model: on the room's **Connectors** page in the web UI, or with `/connectors` and `/connector-key <id>` in `nudge chat` (the key isn't echoed). Keys are stored encrypted and scrubbed from what the model sees.
- A connector belongs to the room it was added in. The owner can share one without a key with every room: `nudge connector share <id> [room]`, and `unshare` to move it back. `nudge connectors [room]` lists a room's.
