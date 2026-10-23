import ICAL from "ical.js";

/** An e-mail address, phone number or postal address, with what kind it is, such as `cell`. */
export type Labeled = { readonly value: string; readonly label?: string };

/** One person or company from an address book. */
export type Contact = {
  /** The formatted name (FN), or one made of the name's parts. */
  readonly name: string;
  /** Given and family name, when the card has them. */
  readonly given?: string;
  readonly family?: string;
  readonly nicknames: readonly string[];
  readonly org?: string;
  /** A company or other organisation rather than a person. */
  readonly company?: true;
  readonly emails: readonly Labeled[];
  readonly phones: readonly Labeled[];
  readonly addresses: readonly Labeled[];
  /** As the card has it: `1950-03-04`, or `--03-04` without a year. */
  readonly birthday?: string;
};

/** Labels that say nothing to a person reading them. */
const NOISE = new Set(["internet", "pref", "voice", "x400", "other"]);

/** The contacts in a vCard text (3.0 or 4.0), one per card; cards without a name are left out. */
export function parseVCards(text: string): Contact[] {
  const parsed = ICAL.parse(text) as unknown;
  const cards = (
    Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed : [parsed]
  ) as ConstructorParameters<typeof ICAL.Component>[0][];
  const contacts: Contact[] = [];
  for (const jcal of cards) {
    const card = new ICAL.Component(jcal);
    if (card.name !== "vcard") continue;
    const contact = toContact(card);
    if (contact !== undefined) contacts.push(contact);
  }
  return contacts;
}

function toContact(card: ICAL.Component): Contact | undefined {
  const parts = card.getFirstPropertyValue("n");
  const [family, given] = Array.isArray(parts)
    ? parts.map((part) => (Array.isArray(part) ? part.join(" ") : String(part ?? "")).trim())
    : [];
  const org = card.getFirstPropertyValue("org");
  const orgName = (Array.isArray(org) ? org.filter(Boolean).join(", ") : String(org ?? "")).trim();
  const name =
    String(card.getFirstPropertyValue("fn") ?? "").trim() ||
    [given, family].filter(Boolean).join(" ") ||
    orgName;
  if (name === "") return undefined;
  const birthday = card.getFirstPropertyValue("bday");
  const kind = String(card.getFirstPropertyValue("kind") ?? "").toLowerCase();
  const company =
    kind === "org" ||
    kind === "group" ||
    String(card.getFirstPropertyValue("x-abshowas") ?? "").toUpperCase() === "COMPANY" ||
    (!given && !family && name === orgName);
  return {
    name,
    ...(given ? { given } : {}),
    ...(family ? { family } : {}),
    ...(company ? { company } : {}),
    nicknames: card
      .getAllProperties("nickname")
      .flatMap((property) => property.getValues().map((value) => String(value).trim()))
      .filter((nickname) => nickname !== "" && nickname !== name),
    ...(orgName === "" || orgName === name ? {} : { org: orgName }),
    emails: labeled(card, "email", (value) => value.replace(/^mailto:/i, "")),
    phones: labeled(card, "tel", (value) => value.replace(/^tel:/i, "")),
    addresses: labeled(card, "adr", (value) => value),
    ...(birthday === null || birthday === undefined || String(birthday).trim() === ""
      ? {}
      : { birthday: String(birthday).trim() }),
  };
}

function labeled(card: ICAL.Component, name: string, clean: (value: string) => string): Labeled[] {
  return card.getAllProperties(name).flatMap((property) => {
    const raw = property.getFirstValue();
    const value = clean(
      Array.isArray(raw) ? address(raw as unknown[]) : String(raw ?? "").trim(),
    ).trim();
    if (value === "") return [];
    const types = property.getParameter("type");
    const label = (Array.isArray(types) ? types : types === undefined ? [] : [types])
      .flatMap((type) => String(type).toLowerCase().split(","))
      .filter((type) => type !== "" && !NOISE.has(type))
      .join(", ");
    return [label === "" ? { value } : { value, label }];
  });
}

/** `Storgata 1, 0155 Oslo, Norge` from ADR's parts: box, extended, street, city, region, code, country. */
function address(parts: readonly unknown[]): string {
  const [box, extended, street, city, region, code, country] = parts.map((part) =>
    (Array.isArray(part) ? part.join(" ") : String(part ?? "")).trim(),
  );
  return [box, extended, street, [code, city].filter(Boolean).join(" "), region, country]
    .filter(Boolean)
    .join(", ");
}
