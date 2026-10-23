# 15. Hide only what does harm on its own

ADR 14 hid quasi-identifiers: names, places, organisations, hosts, plates and the like. In use it hid too much and broke what the assistant does. The local model took "The", "To", "POST", "Home", "Claude", "NSR", "StopPlace" and bare stop numbers for names, places and addresses. Because the vault hides a value everywhere from then on, the model saw `trip(from: …, ⟦NAME44⟧: …)` and Entur stop IDs as `⟦ORG19⟧:⟦PLACE93⟧:⟦ADDRESS40⟧`. It wrote the placeholders back, got them filled in as "To" and "Name", and read Entur's errors about them as placeholders again, so it could not find its mistake. A call with `method: ⟦ORG64⟧` failed the tool's schema before the value was put back.

**Only what does harm on its own is hidden.** Each of these lets someone act as a person, take their money or reach them:

- secrets: provider keys and tokens of well-known formats, private key blocks, JSON web tokens, and what follows "password:", "passord:", "api key" and the like (`SECRET`)
- Norwegian national identity numbers (`NATIONALID`)
- card numbers, IBANs and Norwegian account numbers (`CARD`, `IBAN`, `ACCOUNT`)
- e-mail addresses and phone numbers (`EMAIL`, `PHONE`)
- what a person owns in the vault: their personal details and location (ADR 14), what they made private and what a private message revealed (ADR 9)

**Readable now:** people's names (the players' too), places and stations, organisations, schools and kindergartens, street addresses in text, hosts and domains, IP addresses, user names, licence plates, VINs and birth dates. Together they point to a family, as ADR 14 says. Keeping them from the provider costs more than it saves, though: the assistant can't plan a trip, call an API or tell people apart, and the provider learns the topic anyway.

**The vault releases what it hid before, once.** A released entry keeps its placeholder, but text no longer has its value replaced. `Vault.redact` puts released placeholders back first, so history, memory and extension data that still hold them reach the model readable, without being rewritten. Protecting a released value again, by hand or with a detector, hides it under its old placeholder. On opening, a vault without `readable: 1` releases every entry that nobody owns and that is of kind NAME, PLACE, ORG, ADDRESS, DOMAIN, IP, USERNAME, HOST, PLATE, VIN or BIRTHDATE. Values hidden by hand under one of those kinds, but not as private, are released too. `PRIVATE`, owned and forgotten entries stay as they were.

**The local model is opt-in.** `privacy.deep` defaults to `"off"`, so nothing is downloaded or run. Turning it on (`"required"` or `"preferred"`) brings back what ADR 14 hid: the model and the rules for names, places, organisations, hosts and the rest (`quasiIdentifierDetectors`). Values released before stay released until something finds them again. While it is on, the release is left for later, so turning it off releases them then. Players' names are no longer protected either way. Hosts can still pass `privacy.detectors` for their own set, and the `ner` extension still hides the names listed in its settings.

What this doesn't do:

- Tool arguments are still checked against the tool's schema before values are put back. A hidden value in an enum, such as an e-mail address the schema lists, fails there.
- The model still can't read images.

Supersedes the part of ADR 14 about quasi-identifiers. ADR 14's thinking, history rewrite and local model sections still hold where the local model is on.

Amended by ADR 16: the `contacts` extension hides the address books' whole names, e-mail addresses and phone numbers.
