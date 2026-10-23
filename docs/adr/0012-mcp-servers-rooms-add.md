# 12. Rooms add MCP servers the way they add connectors, and sign in with OAuth on the server

People should be able to give the assistant an MCP server from the chat, as they add connectors (ADR 6), instead of only an admin through the extension's settings. A server is either a remote one, reached by its URL, or a program the Nudge server starts.

**A room's servers are data, scoped like connectors.** `add_mcp_server` files an approval that shows the exact URL or command line; approving it adds the server to the room's `nudge.mcp.servers` doc. What to add is the approval's payload, stored with placeholders (ADR 9) like any other; the vault gives each way a value is written its own placeholder, so a path such as `/home/vegard/…` comes back exactly as asked. The servers in the extension's settings stay as they are, assistant-wide, with their `mcp__<server>__<tool>` tools.

**A program needs an admin.** It runs on the server as Nudge's user, able to read what Nudge can, so its approval is `adminOnly`: a new flag on approvals that `Approvals.decide` checks against the players' admin flag, refusing anyone else (`AdminOnly`, 403 over HTTP). It gets only the variables the room set plus `PATH`, `HOME` and the locale, and its own directory under the extension's data as its working directory, but no sandbox yet.

**Fixed tools, not one per server tool.** Pi Durable registers tools when an extension is set up, and a room's servers change while it runs, so the model gets `mcp_tools` (a server's tools with their input schemas, searchable), `mcp_call` and `remove_mcp_server`. Reads (tools the server marks read-only) run at once; other calls wait for anyone in the room, as for configured servers; people change that per server on the panel, never the model.

**Keys and sign-ins go on the room's MCP panel, never in chat.** The model names the headers or variables that need a value; people set them on the panel (the extension's room socket), and they are kept in the extension's `SecretStore` per room and scrubbed from results. A remote server that answers 401 needs a sign-in: the panel starts pi-mcp's OAuth flow (discovery, dynamic client registration, PKCE) with the redirect URI `<base>/v1/a/<assistant>/ext/mcp/oauth/callback`, where `base` is the address the person's app reaches the server by, since a server may have no public name of its own. The extension's callback route (no token; matched by the flow's `state`, kept in memory for 15 minutes) finishes it. Tokens and the client registration are kept in the `SecretStore` and refreshed on use. A client registered for another redirect URI, as from another device's address, is registered again; a refresh that fails needs a new sign-in from the panel.

Left for later: a sandbox for programs (bubblewrap, as the terminal's), servers shared with every room, and a block on private addresses for remote servers like the connectors' (a person approves the exact URL instead).

## Images and redaction — later

Redaction (ADR 2) reads only text, so an image in a tool result would reach the provider with whatever it shows. For now images are left out (`[an image, not shown]`): a configured server passes them only with an explicit `unredactedImages: true` in its own settings, which `nudge doctor` warns about, and a room's servers never do. Options for showing images safely later, design only:

- **Read the text, redact it, send the text.** Run OCR locally (such as Tesseract, or a small on-device model) and pass the redacted text in place of the image. It reuses the redaction that exists and keeps pictures from the provider entirely, but loses layout, charts and anything that isn't text.
- **Describe the image locally.** A small local vision model writes a description, which then goes through redaction like any text. Covers more than OCR (what a screenshot or photo shows), at the cost of a download like the local name finder (ADR 14), slower turns, and descriptions that can be wrong.
- **Blur what looks private.** Find text regions with local OCR, run the detectors on their text, and blur or box the regions that held a private value before sending the image itself. The model still sees the picture, but faces, handwriting and text OCR misses get through, so it suits screenshots of apps more than photos.
- **Let a room opt in.** A room setting, changed on the MCP panel by people and never by the model, that lets one of its servers pass images unredacted, shown in the room the way approvals are. This is the least work, but it moves the risk to people rather than reducing it, so it fits best combined with one of the above.

A likely order: OCR then redact as the default for servers that opt in, the per-room opt-in for rooms' servers on top of it, and blurring once OCR is in place.
