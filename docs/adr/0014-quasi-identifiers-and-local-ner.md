# 14. Hide what points to a person, not only what names them

ADR 2 hid values with a fixed shape (e-mail addresses, phone and account numbers) and the names of the people chatting. That left most of what identifies someone in clear. When asked what it knew, the model listed a home town and its station, a child's kindergarten and its departments, the vet, a Home Assistant domain and a car, all from earlier messages and its own thinking. Each says little on its own; together they point to one family.

**Every assistant finds quasi-identifiers, with rules and lists on the host.** The built-in detectors now also find:

- names and street addresses (moved from `extensions/ner` into core, which keeps only `extraNames`)
- Norwegian places: kommuner, tettsteder and rail stations from SSB and Entur. Short names that are also words ("Ski", "Moss") count only after "i", "fra" or "near".
- organisations someone belongs to: the name before "barnehage", "skole", "dyreklinikk", "IL", "AS" and the like, and departments ("avdeling Blåveisen"). The word for the kind of place stays, so the model still knows it is a kindergarten.
- hosts: every host except the 10,000 most visited domains, popular `.no` ones, and the names RFC 2606 keeps for examples. Personal subdomains of hosting suffixes (`*.github.io`, `*.ts.net`) and private names (`.local`, `.lan`) are always hidden.
- IP addresses, user names in paths and logins, licence plates, VINs, and dates after "født", "born" or "DOB"

A player's first name and family name are also protected on their own, so "/home/vegard" and "Svendsens bil" are hidden. The lists are made by `packages/core/scripts/privacy-data.mjs` and committed.

**Placeholders still say only the kind** (`⟦PLACE1⟧`, `⟦ORG2⟧`), not hints such as "a kindergarten". Tools get the values back as before, so a journey planner gets the real station.

**Readable on purpose:**

- the topic ("has a dog", "selling a Tesla Model Y")
- the time zone and language of each person, which the model needs for times and replies
- Oslo, Bergen, Trondheim and Stavanger, whose names say little about anyone
- well-known public sites

**Thinking is dropped, not exempt.** ADR 2 left thinking alone because providers replay it signed. Thinking from before a value was known, unsigned thinking (which another model gets as plain text), and every thinking block before the newest user message are now left out of requests. History rewrites store thinking redacted and without its signature.

**History is rewritten once when the detectors change.** `REDACTION_VERSION` goes up when they find more. Opening an assistant whose `<database>.redaction` holds an older number runs `redactHistory` first, so old messages, memory and thinking lose the values at rest too, not only in requests.

**Next: a local model.** Rules miss names without a cue, such as "hos Vethjem". The plan is a small multilingual NER model (GLiNER-style, ONNX on the CPU) that reads each new message and personal tool result once, when it is stored, and adds what it finds to the vault. Exact matching then hides those values in every later request. Requests fail closed while the model is missing. That is not built yet.

What this still doesn't do:

- Images pass through as before.
- The model can infer from topics.
- Rules hide some public names, such as hosts below the top list. **Model view** shows what was hidden.
