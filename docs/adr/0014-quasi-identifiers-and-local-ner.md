# 14. Hide what points to a person, not only what names them

ADR 2 hid values with a fixed shape (e-mail addresses, phone and account numbers) and the names of the people chatting. That left most of what identifies someone in clear. When asked what it knew, the model listed a home town and its station, a child's kindergarten and its departments, the vet, a Home Assistant domain and a car, all from earlier messages and its own thinking. Each says little on its own; together they point to one family.

**Every assistant finds quasi-identifiers, with rules and lists on the host.** The built-in detectors now also find:

- names and street addresses (moved from `extensions/ner` into core, which keeps only `extraNames`)
- Norwegian places: kommuner, tettsteder and rail stations from SSB and Entur. Short names that are also words ("Ski", "Moss") count only after "i", "fra" or "near".
- organisations someone belongs to: the name before "barnehage", "skole", "dyreklinikk", "IL", "AS" and the like, and departments ("avdeling Blåveisen"). The word for the kind of place stays, so the model still knows it is a kindergarten.
- hosts: every host except the 10,000 most visited domains, popular `.no` ones, and the names RFC 2606 keeps for examples. Personal subdomains of hosting suffixes (`*.github.io`, `*.ts.net`) and private names (`.local`, `.lan`) are always hidden.
- IP addresses, user names in paths and logins, licence plates, VINs, dates after "født", "fødselsdatoen", "born", "birth date" or "DOB" and in lists under "Bursdager:", and eight digits written together after "Mobil:", "ring", "sms til" and the like

A player's first name and family name are also protected on their own, so "/home/vegard" and "Svendsens bil" are hidden. The lists are made by `packages/core/scripts/privacy-data.mjs` and committed.

**Placeholders still say only the kind** (`⟦PLACE1⟧`, `⟦ORG2⟧`), not hints such as "a kindergarten". Tools get the values back as before, so a journey planner gets the real station.

**Readable on purpose:**

- the topic ("has a dog", "selling a Tesla Model Y")
- the time zone and language of each person, which the model needs for times and replies
- Oslo, Bergen, Trondheim and Stavanger, whose names say little about anyone
- well-known public sites

**Thinking is dropped, not exempt.** ADR 2 left thinking alone because providers replay it signed. Thinking from before a value was known, unsigned thinking (which another model gets as plain text), and every thinking block before the newest user message are now left out of requests. History rewrites store thinking redacted and without its signature.

**History is rewritten once when the detectors change.** `REDACTION_VERSION` goes up when they find more. Opening an assistant whose `<database>.redaction` holds an older number runs `redactHistory` first, so old messages, memory and thinking lose the values at rest too, not only in requests.

**A local model reads what the rules can't.** Rules miss names without a cue, such as "hos Vethjem". A GLiNER model (`urchade/gliner_multi-v2.1`, Apache-2.0, as onnx-community exports it to ONNX) runs on the CPU in a child process of the server, through `onnxruntime-node`. It is asked for people, street addresses, cities, locations, organisations, schools, kindergartens and companies, and they become `NAME`, `ADDRESS`, `PLACE` and `ORG`. What it finds goes into the vault, and exact matching hides it in every later request.

- **Where it reads:** every request, before redaction: what people wrote, tool results, and prompt sections made from the assistant's data (memory, lists, calendar, personal details). What the model wrote itself only holds what it was shown, so it isn't read. A message is also read when it is sent, so what a private message reveals is its author's alone.
- **Once:** text is read in lines of at most 200 words. Lines without a capital letter, a digit or a known given name are skipped. Each line's hash is kept in `nudge.deepSeen`, so a restart doesn't read every room again. Short lines go to the model together, up to 50 words a call, one per line: a call costs about the same whatever its length, so this reads twice as fast, and the lines around one help as much as they hurt.
- **Thresholds per kind:** a person needs a score of 0.3, an address, place or organisation 0.5. Names matter most, and at 0.3 fewer slip through without much more hidden. A person's given and family names are protected on their own too, as players' are, so "Torunn's" is hidden after "Torunn Myhre". A name typed in lower case counts when it starts with a known given name ("hent emma").
- **Public results stay readable:** an extension names its tools whose results are the public web (`publicTools`). Web search and `read_page` do, so restaurants in search results aren't hidden. Values the vault already knows are still hidden there.
- **What it gets wrong:** its spans run long ("Vethjem for katten", "Søster Helene"), so words in lower case, family words and titles at either end are dropped, and lists are split ("Priya and Daniel"). Pronouns, family words, the big cities and the assistant's own name are never hidden, nor words in `privacy.allow`.
- **Well-known names stay readable.** The model takes every brand, shop, programme and famous person for something to hide, and hid more than a third of what the model provider needed ("Rema 1000", "Netflix", "Erling Haaland"). `scripts/privacy-data.mjs` makes a list from Wikidata of famous people's full names (40 Wikipedia languages, or 12 for Norwegians), and of companies, brands, products, programmes, sites, venues and attractions (2 languages for Norwegian ones, 15 for others). Left out are settlements, streets, schools, kindergartens, small sports clubs, people's single names, single words that are a given name or a family name 200 people in Norway have (SSB), and a common given name with a common family name. Neither the model nor the rules hide what is on it, and a finding that starts or ends with it keeps it readable ("IKEA Slependen" hides "Slependen"). Countries and big cities abroad are on a list of their own that counts only for places, since "Paris" is also a family name. The list takes about 35 MB of memory, also on Cloudflare.
- **Fail closed:** while the model is missing (downloading, or broken), requests are refused with a message saying so, and nothing is sent. `privacy.deep: "preferred"` sends them with the rules alone instead, and `"off"` never downloads it. Messages are stored either way and read once the model runs.
- **Download:** `nudge serve` starts the download into `server/models` beside the config when it starts, even before the server is set up. `nudge chat` does it the first time. Each file is checked against the sha256 Nudge pins. `nudge doctor` checks the hashes again and that the model finds "Vethjem".
- **Made smaller, not less accurate:** the original file is 1.2 GB and takes 1.7 GB of memory. onnx-community's int8 and uint8 exports, and dynamic int8 of our own, find nothing, because mDeBERTa's activations don't survive it; their 4-bit export misses "Vethjem". `packages/core/scripts/local-model.py` makes our own from the original instead. The vocabulary keeps the 135k of 250k pieces in Latin script, with the embedding and tokenizer renumbered; a piece with another script's letters can't match Latin text, so Norwegian and English tokenize exactly as before. The embedding is stored in 4 bits and the encoder's matrices in 8, weights only, so the activations stay in full precision. The result is 260 MB, finds the same 61 of 61, takes about 650 MB in memory and about 35 ms for a short message. Names in other scripts (Cyrillic, Chinese) aren't read. The files are published as assets of a GitHub release (`local-model-1`), pinned by hash.
- **Only while there is reading to do:** the process stops after two minutes without a call and starts again in about a second, so an idle server holds none of that memory.
- **Not on Cloudflare:** a Durable Object can't run it, so there only the rules run.

**Measured, not guessed.** `packages/core/eval/privacy` runs 256 messages, memory sections and tool results (220 written for it, held out from the model choice, and the first 36) the way a request runs, and counts tier 1 values (full names, contact details, addresses, ID and account numbers, birth dates, plates, private hosts) left readable, tier 2 values (given names, small places, kindergartens, schools, clubs, employers) left readable, and values the model provider needed that were hidden. On 2026-10-21:

| | tier 1 readable | tier 2 hidden | needed but hidden | per line |
|---|---|---|---|---|
| rules alone | 39 of 322 | 62% | 17 of 599 | – |
| rules and model before this (one threshold of 0.5) | 15 of 325 | 87% | 240 of 643 | 34 ms |
| now | 1 of 322 | 89% | 91 of 599 | 19 ms |

The tier 1 value still readable is a birth date the text only implies ("fyller 70 … Tror det var 12.12.1956"). Norwegian places other than the big cities are hidden on purpose, so 25 of the 44 the test set wanted readable are hidden. The label set and the length of what the model reads at once barely change the result; the model's 8-bit weights make a call 2.3 times slower than full precision for a third of the memory.

What this still doesn't do:

- Images pass through as before.
- The model can infer from topics.
- Rules and the model hide some public names, such as hosts below the top list and brands Wikidata doesn't know well ("Kiwi", "Vipps"). **Model view** shows what was hidden.
- Tool declarations aren't read.
