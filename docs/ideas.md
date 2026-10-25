# Ideas not built yet

These are design notes, not plans. Each one says what is missing and what it means for redaction ([Privacy](privacy.md)): what reaches the model provider, what is stored, who in a room sees what. Two of the four, contacts and maps, are partly built already, so their notes cover what is still missing.

## Contacts: writing to the address books

**There already:** `extensions/contacts` reads CardDAV address books and gives the model `contacts_search`. Its people are known private values: their e-mail addresses, phone numbers and whole names are hidden wherever they show up ([ADR 16](adr/0016-contacts-are-known-private-values.md)).

**Missing:** adding and editing contacts ("save Bo's new number"), and making use of the postal addresses the cards hold.

- **Writes wait for approval**, as `calendar_add` does. The approval shows the card with the values put back, to the person who approves it.
- **A new value is hidden from the message that brings it.** The contacts' detectors only learn a value when the address books are read again, up to 15 minutes later, so "Bo's new number is 91234567" would reach the model readable until then. When the model writes a value, the extension protects it in the vault right away, the way `places` protects what someone typed to save a place (ADR 18). The model passes the placeholder to the tool, and the tool gets the real value.
- **Postal addresses are a known list too.** ADR 15 keeps street addresses readable because guessing at them broke things. A contact's address isn't a guess, and it says where someone lives. It could be hidden as a named place, `⟦PLACE:grandma⟧`, with no owner, since the address book belongs to the room's account and not to one person. Then `route` to grandma's works without the model learning the street. `hideAddresses: false` would keep them readable. Birthdays stay readable.
- **Who sees it.** The values have no owner, so everyone in a room that may use the account sees them, as with reading today. A personal address book belongs on an account that only the person's own room may use.
- **Contact photos** never go to the model, as images don't.

## Maps, directions and location: what's left

**There already:** location from the apps, owned by the person and kept to their home assistant ([ADR 14](adr/0014-personal-details-and-location.md)); `places` with named places, arrival reminders, `find_place` and `route` on the server's own map ([ADR 18](adr/0018-places-and-arrival.md)).

**Missing:** public transport, showing a map, and telling someone else where you are ("tell Bo I'm ten minutes away").

- **Public transport** would come from a journey planner (Entur in Norway) through a connector or a new tool. Asking one tells it where a trip starts and ends, so the tool should take named places and resolve them to stops near the place itself, not send the person's own coordinates. A stop near home still says roughly where someone lives: the planner learns it, the model doesn't. Stop IDs and station names stay readable (ADR 15), since trips can't be planned without them.
- **A map in the apps** has to draw from the server's own data, never from a public tile server. Every tile someone looks at tells the server where they are or where they are going, which is what ADR 18 keeps from outside services. The coordinates go only to the person's own device, as `GET /ext/places/regions` already does, and never into a tool result.
- **Sharing an ETA** sends something derived from a location to another person. It is an outward action: it waits for the person's approval, and only their own location may be used for it, in a room where they let the assistant know where they are (ADR 14). The message says "about 10 minutes away" and no street; the model writes it from the route's time, not from coordinates.
- **Hosts without a map**, such as Cloudflare, still can't do any of this. They should keep saying so rather than fall back to a public service.

## Spoken replies (text to speech)

**There already:** dictation in the Apple app runs whisper on the device, so the voice never leaves it. The avatar has a `speaking` pose. Nothing speaks the replies yet.

**The idea:** the apps, and the web, read an answer aloud, and the chat bridges send it as a voice note.

- **Speak what the person sees, never what the model wrote.** The model's text holds placeholders. The client already gets the reply with the values put back for that person (ADR 9), so it speaks that text: their own address, a contact's number. Values hidden from them are spoken as "hidden", not read out letter by letter. A named place is read as its name: `⟦PLACE:home⟧` is "home".
- **The voice must be made on the device or the server, never by a cloud voice.** A cloud voice would get the whole reply with every value filled in, which is more than the model provider ever sees. On Apple, `AVSpeechSynthesizer` speaks on the device. On Android, the engine's voice has to have `isNetworkConnectionRequired()` false, or no voice is used. On the web, only voices with `localService: true` are offered; Chrome's Google voices are sent to Google. For the chat bridges, the server would run a local voice (Piper, for example) beside its other local models.
- **Out loud is not private.** A speaker in a kitchen tells everyone in it. Answers to a private message (`/whisper`), and replies that hold the person's own values, are not spoken unless the person asks for them in that reply, or they turn speaking on for the device knowing this. A reply in a shared room is spoken only on the device of the person who asked.
- **Voice notes on the bridges** carry what the text reply would carry, to the same chat. They add nothing new for redaction, but they are files the bridge's service keeps. That is no worse than its copy of the text, and should be said in the bridge's docs.
- **Nothing reaches the model that it hasn't seen.** Speaking is done after the answer is written, so it changes nothing in what is sent to the provider or what is stored.

## Mail attachments into documents and the workspace

**There already:** `mail_read` gives the text of a message and drops its attachments. People upload files to a room's documents by hand, and the terminal copies documents into `/workspace` with `document_to_workspace` and back with `workspace_to_documents`.

**The idea:** "save the invoice from the plumber" takes a PDF from a mail into the room's documents, where `search_documents` and the terminal can use it.

- **`mail_read` lists the attachments** by number, name, type and size. File names pass through redaction like the rest of the mail, so `faktura-91234567.pdf` reaches the model as `faktura-⟦PHONE1⟧.pdf`; the tool works by number, so a hidden name doesn't break it. The list is marked untrusted with the rest of the mail (ADR 20).
- **`mail_save_attachment(account, uid, number)`** adds it to the documents of the room that asked, which must be a room the account may use. Nothing leaves the server, so it doesn't wait for approval, even in a turn that read untrusted data. It is a write a stranger's mail could ask for, though, so documents could be flooded: it keeps the documents' size limit (20 MB), takes only the kinds the documents read, skips a file already there (by `sha256`), and caps how many one turn may save. The document's note says which mail it came from, and `addedBy` is the person whose message started the turn.
- **The text is read on the host and redacted on the way out**, as with uploads: the original stays encrypted, and the model gets search results and pages as placeholders. Scans and images are kept but not read, since that would mean sending the picture to a provider. The documents' text is stored as it was read, not as placeholders (see [Privacy](privacy.md)); forgetting a value doesn't take it out of a saved document.
- **The workspace goes through the documents**, by `document_to_workspace`, rather than straight from the mail. That keeps one way in, with its checks, and the terminal's rules decide what may leave it: a turn that read the mail already asks before each command when the network is on (ADR 20).
- **Who sees it.** Everyone in the room sees the room's documents. A mail read in a shared room is already seen by the room, so saving its attachment there tells them nothing new, but a private message's turn (`/whisper`) should not save into a shared room's documents, or should ask the person first.
- **Sending attachments** (a document with `mail_send`) is the other direction. It is an outward action that already waits for approval; the approval should name the file, since the model might pick the wrong one.
