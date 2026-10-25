# Privacy

Nudge keeps what could do harm on its own from the model provider. Before a request leaves, it replaces these with placeholders such as `⟦EMAIL1⟧` or `⟦PHONE2⟧`:

- passwords, API keys, tokens and private keys
- Norwegian national identity numbers
- card numbers, IBANs and Norwegian account numbers
- e-mail addresses and phone numbers
- whatever someone makes private, and their personal details and location (below)

This covers every request, including tool rounds and the summaries made when a long conversation is compacted. Thinking that could hold a value is left out. A value keeps its placeholder for the life of the assistant. Tools still get the real values, so a mail goes to the real address.

Names, places, stations, organisations, addresses, hosts, plates and birth dates stay readable, so the assistant can plan a trip, call an API or tell people apart. Hide one yourself with `/private` ([ADR 15](adr/0015-hide-only-what-is-critical.md)).

For more, a small model on the server hides names, places and organisations too, such as a vet's name on its own ("hos Vethjem"), along with the rules for hosts, plates and birth dates. It is off unless `nudge.json` has `"privacy": { "deep": "required" }`, which refuses requests until the model runs, or `"deep": "preferred"`, which sends them with the rules alone meanwhile. `"allow": ["Kiwi"]` keeps words it hides by mistake readable. Famous people, companies, brands and big cities abroad stay readable either way. The model is GLiNER (`urchade/gliner_multi-v2.1`, Apache-2.0), run on the CPU in a process of its own. It is downloaded the first time: about 260 MB, into `server/models` beside `nudge.json`. While it reads it takes about 650 MB of memory; after two minutes with nothing to read it stops. Assistants on Cloudflare run the rules alone ([ADR 22](adr/0022-quasi-identifiers-and-local-ner.md)). Check what a room sends with **Model view**.

The history is stored with the placeholders too: messages, answers, tool results, memory, approvals and nudges. The values are kept in one place, the vault, and put back only where a person sees them (and where a tool acts on them, such as sending a mail). So forgetting a value takes it out of all history at once ([ADR 9](adr/0009-placeholders-at-rest-and-per-person-visibility.md)). The vault keeps only a hash of a forgotten value, so written out again it is still hidden behind its old placeholder, and the model never gets it; hiding it again on purpose keeps it once more, under a new placeholder. When the detectors learn more, the history is rewritten with them once, the next time the assistant opens.

In a shared room, you can keep things to yourself:

- **A value:** `/private <value>` in chat, or "Hide a value" in the web UI and the apps, keeps a value, such as an address, from the model and from everyone but you, wherever it shows. They see it as hidden. `/hidden` lists yours, and `/hidden forget <placeholder>` (or Forget) drops one for good, for everyone and the model.
- **A message:** `/whisper <text>`, or the Private switch by the message field, sends a message only you see, and the answer to it. The others see that you sent one. Approvals, nudges, facts and watches that answer makes are yours alone too. The assistant is told not to bring it up with the others; it may still, in its own words, so don't count on it for secrets from the model's memory.

Your personal details help the assistant fill in forms, write mail for you and find what is near you. Give your full name, e-mail, phone and address under **Personal details** on your profile (web and apps), and turn on **Share where I am** in the apps to tell it where you are while the app is open. Each value is yours alone in the vault: the model only ever gets placeholders for them, such as `⟦ADDRESS1⟧`, and only in your personal room and your private messages, so nobody else can have the assistant use them; tools get the real values when they act for you. They stay on your home assistant and don't travel with your profile. A new location replaces the last one, which is forgotten for good, and one within 100 m of it keeps its placeholder. In a shared room, the assistant knows where you are only after you turn on **Let the assistant know where I am** in the room's Location settings; then anyone there can ask it about what is near you, everyone in the room sees that you share it, and the place itself stays hidden from them and the model. Where the assistant knows someone's location, the room says so above the chat or under its name ([ADR 14](adr/0014-personal-details-and-location.md)).

More:

- `nudge doctor --privacy` checks the detectors against sample data. `pnpm -C packages/core eval:privacy` measures what the rules and the local model hide, and what they hide that the model needed, on 256 test messages. With the local model on, `nudge doctor` checks its files and that it finds a name.
- `NUDGE_DEBUG_REQUESTS=1 nudge chat` (or `nudge serve`) writes every request, exactly as the provider receives it, to `<database>.requests.jsonl`.
- **Model view** on a room's page in the web UI (or `GET /rooms/<id>/model-view`) shows anyone in the room what its next request sends: the instructions and sections, every message and tool call, with placeholders where the values were.

`extensions/ner` adds names the lists don't have, such as relatives' (`extraNames`). `extensions/contacts` hides the whole names, e-mail addresses and phone numbers in your address books ([Contacts](../README.md#contacts), [ADR 16](adr/0016-contacts-are-known-private-values.md)).

Display names of players are always protected. Images are passed through unchanged. That is why images people attach to messages reach the model only in a room where people turned `imagesToModel` on; elsewhere the model gets only a line naming each attachment ([ADR 24](adr/0024-attachments-in-chat.md)). Extensions keep their own data (connector notes, browser site notes, uploaded documents) as they stored it.
