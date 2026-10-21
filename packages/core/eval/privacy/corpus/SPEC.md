# Privacy eval corpus

Each file in this directory is a JSON array of items. Nudge is a personal assistant (Norwegian
household, nb and en). Before any text reaches a cloud LLM, Nudge hides personal values with
rules plus a local NER model (GLiNER). The eval checks two things per item: every value in
`hide` is gone from the text the LLM sees, and every value in `keep` is still readable.

```ts
type Item = {
  id: string; // "<file>-<nnn>", e.g. "chat-nb-007"
  source: "chat" | "memory" | "mail" | "calendar" | "contacts" | "tool" | "web";
  lang: "nb" | "en" | "mixed";
  text: string;
  hide: [value: string, kind: Kind, tier: 1 | 2][];
  keep: string[];
};
type Kind = "NAME" | "ADDRESS" | "PLACE" | "ORG" | "EMAIL" | "PHONE" | "NATIONALID" | "ACCOUNT"
  | "IBAN" | "CARD" | "BIRTHDATE" | "PLATE" | "VIN" | "IP" | "DOMAIN" | "USERNAME";
```

## Sources

- `chat`: what a person types to the assistant.
- `memory`: a prompt section built from the assistant's stored data (memory notes, lists, personal
  details), e.g. "- Datteren Emma går på Lindeberg skole, 3B".
- `mail`, `calendar`, `contacts`, `tool`: tool results (mail bodies with headers and signatures,
  calendar events, contact cards, Home Assistant states, terminal output, connector JSON).
- `web`: a web search result or public page. Nudge does NOT run the local model on these (only
  the rules), because they are the public web; mostly `keep` values, few or no `hide` values.

## Tiers

- **Tier 1, must never leak**: a private person's full name (first + last), e-mail, phone,
  street address (street + number, with or without postcode), national ID (fødselsnummer, 11
  digits; use numbers that look real), bank account (11 digits, 4.2.5), IBAN, card number, birth
  date, licence plate (e.g. "EL 12345"), VIN, IP address, a private host or domain
  (e.g. "hass.kjeks.dev", "nas.local").
- **Tier 2, should not leak**: a private person's first name or family name on its own, nicknames,
  small towns and villages, rail/bus stops near home, the names of kindergartens, schools,
  employers, clinics, vets, sports clubs, departments ("avdeling Blåveisen"), user names
  (in paths, logins).

## Rules for annotating

- Every `hide` and `keep` value must occur verbatim (same casing) in `text`. For possessives
  ("Emmas", "Ola's"), list the base name ("Emma", "Ola") — the eval checks with word boundaries
  and counts "Emmas" as a leak of "Emma".
- For an organisation, list only the distinctive name: "Skogkanten" for "Skogkanten barnehage",
  "Vethjem" for "Vethjem dyreklinikk", "Lindeberg" for "Lindeberg skole". The word for the kind
  of place may stay readable.
- A full name is one `hide` entry ("Kari Nordby", tier 1); do not also list its parts.
- Do NOT hide: public figures (politicians, artists, athletes), public companies and brands when
  they are used as a product or shop (IKEA, Rema 1000, Kiwi, Tesla, Netflix, Vipps, Finn.no,
  Ruter, Entur, Vinmonopolet), the big cities Oslo, Bergen, Trondheim, Stavanger, countries,
  well-known public places and sites (Holmenkollen, Gardermoen, nrk.no, yr.no, github.com),
  weekdays, months, holidays, sums, times, products. Put such values the task needs in `keep`.
- The household's people are **players** of the assistant and are already protected by Nudge
  without any detection: "Vegard Svendsen" (the user) and "Ingrid Svendsen" (partner). Use them in
  at most one item in ten. Most names must be third parties Nudge has never seen (children,
  teachers, colleagues, neighbours, doctors, friends, craftsmen).
- Use invented people, addresses and numbers. Make them realistic and varied: Norwegian names
  (incl. æøå, hyphenated "Kari-Anne", "Ola Nordmann"-style), immigrant names (Ahmed Hussein,
  Nguyen Thi Lan, Zofia Kowalczyk), English names; addresses like "Storgata 14B, 1920 Sørumsand";
  phones like "912 34 567", "+47 41234567", "41234567"; small places like Sørumsand, Fetsund,
  Nittedal, Ås, Hurdal, Kløfta, Bjørkelangen, Vikersund.
- About one in four items should be **hard negatives**: no personal values at all but many
  capitalised public names (brands, public figures, big cities, products, events) in `keep`, with
  `hide: []`. These measure over-redaction.
- Make items realistic for a personal assistant: reminders, shopping, school and kindergarten
  logistics, vet and doctor visits, travel, car, house, work, money, smart home, coding.
  Include hard cases: names with no cue ("Spør Tobias om han kan"), lower-case typing ("hent
  emma kl 4"), names that are also words (Sol, Liv, Tor, Ask, By, Rose, Bjørk, Eik, Frøya), names
  at the start of a sentence, lists of names ("Ola, Kari og Per"), names in e-mail signatures,
  addresses without "gate"/"vei", dialect and typos.
- Write valid JSON (UTF-8, æøå as is, no comments, no trailing commas). Use `\n` for line breaks
  inside `text`.
