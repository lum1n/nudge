# 27. Tools show cards in the chat, which each app draws with its own controls, and a press comes back as a message

Some answers fit a chat bubble badly: a choice between three times, a form with four values, two flats side by side. Until now the only structured UI in the transcript was the approval card: its Approve and Deny buttons, its `inputs` and its `clientAction`. MCP Apps and similar efforts let a tool return HTML that runs in an iframe or a web view. That gives the most freedom. But it would mean running code from a tool, or from a page the tool read, in every app: a web view with its own sandbox on iOS and Android, a strict iframe on the web, and a bridge for the code to call back. Nudge's apps draw everything natively, and a tool's output is often untrusted (ADR 20).

**A card is data, not code.** A tool puts a `UiCard` in its result's `details.ui`:

- `v: 1`, an optional `title`;
- `blocks`: `heading`, `text` (markdown), `kv` (label and value pairs), `list` (title and subtitle), `table`, `image` and `divider`;
- `fields`: `text`, `number`, `boolean` or `choice` (with `options`), each with a name and a label, optionally `optional`, `placeholder` and `multiline`;
- `buttons`: up to 6, each with an id, a label, an optional `style` (`primary` or `danger`), and `skipsFields` for one such as "Cancel";
- `once` (true when absent): the buttons work once, for anyone;
- `who`: `room` (anyone in the room may press, the default) or `asker` (only who the answer was for).

The schema lives in `@nudge/core/ui-card` and is part of protocol v1. Each app draws the card with its own controls. Nothing in it runs or loads from elsewhere: an image is one of the room's attachments (ADR 24) by id, never an address, so a card can't make an app fetch a tracking pixel. A card from a tool that read a hostile page is still just text and buttons.

**It rides on the tool part, not a new part type.** Older clients drop a part type they don't know (the Rust client turns it into `Unknown`), but they keep a tool part and show its `result` text. So the card goes in `details`, which the transcript already stores and every client already passes through. The protocol projection checks it against the schema and leaves out a `ui` that fails, so clients can trust what they get. A view leaves out a tool's details over 8 KiB, so `show_ui` refuses cards over 7 KiB, with a message saying so.

**The model has a tool for it.** The built-in extension's `show_ui` takes the card without its version and returns it as `details.ui`. Its description says when to use a card (picking between options, filling in several values, comparing side by side) and when not to (plain answers). Any extension's tool can return a card too.

**A press is a message from whoever pressed.** `POST /rooms/<id>/ui/<callId> { button, values? }`:

1. finds the tool result in the room's conversation (from the newest entry, up to 5,000 entries back), and the message, nudge or approval its answer is to;
2. refuses with 404 when the answer is private to someone else, with 403 when the card is `asker` only and the caller isn't who it was for, and with 400 when the button is unknown, a required field is empty, or a value has the wrong type;
3. marks the press in one commit, per conversation (`nudge.ui-presses`), so two people pressing a card that works once can't both get through (409 for the second);
4. posts the press with `Nudge.submit` as the caller's message, such as `Pressed "18:00" on "Pick a time"` with a line per field, and `press: { callId, button }` on the entry.

Because a press is an ordinary message, it goes through redaction (ADR 9), the budget, the queue while the assistant is busy, and the model sees who pressed and when. A card in a private answer is pressed privately. The model never waits on a press, so a turn doesn't hang on someone who never answers, and people may always write instead. If the message can't be posted, the mark is taken back.

The timeline shows `press` on the user item, and `pressed: { button, by }` on the tool part, which is the latest press. That lets a client show a pressed card as done without looking further.

**What fields may hold is shown to the model.** A card's values reach the model as the message's text, so fields are never secret, and `show_ui`'s description says not to ask for passwords or keys with them. Approvals keep their `inputs` for that: those go to the extension and are never stored or shown.

**Each client draws it natively.** The web app, Android (Compose) and Apple (SwiftUI) have a card view. Each client library parses the card leniently, skipping blocks it doesn't know, so a later block type doesn't drop the whole card. The Swift and Kotlin libraries read the card from `detailsJson`, where the FFI also puts `pressed`. The apps don't fetch attachments yet, so an image block shows its `alt` text there. The web app fetches the image.

Rendering HTML from MCP servers (MCP Apps) stays possible later, behind a part of its own, for clients that can sandbox it. This ADR covers the part every client can draw.
