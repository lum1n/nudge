/**
 * Verbs that, first in a control's label, commit the user to something: buying, paying,
 * booking, sending, deleting, publishing, signing up. English and Norwegian.
 */
const VERBS = [
  "buy",
  "purchase",
  "pay",
  "book",
  "reserve",
  "send",
  "submit",
  "delete",
  "confirm",
  "publish",
  "post",
  "register",
  "subscribe",
  "unsubscribe",
  "donate",
  "transfer",
  "kjøp",
  "betal",
  "bestill",
  "reserver",
  "slett",
  "bekreft",
  "publiser",
  "registrer",
  "abonner",
  "overfør",
  "signer",
  "doner",
  "fullfør",
];
/** Phrases that commit the user wherever they are in a label. */
const PHRASES = [
  "place (?:your |the )?order",
  "order now",
  "complete (?:your |the )?(?:order|purchase|booking|payment)",
  "sign up",
  "send inn",
  "meld (?:deg |meg )?på",
  "legg ut",
];
const LETTER = "[\\p{L}\\p{N}]";
const FIRST = new RegExp(`^(${VERBS.join("|")})(?!${LETTER})`, "iu");
const ANYWHERE = new RegExp(`(?<!${LETTER})(${PHRASES.join("|")})(?!${LETTER})`, "iu");
/** Cookie and consent dialogs: "Confirm my choices", "Bekreft valg" commit nobody to anything. */
const CONSENT =
  /cookie|consent|samtykke|informasjonskapsl|personvern|privacy|choices|valg|preferences|preferanser/iu;
/** Longer than this, a "label" is a card or a paragraph, not a button's words. */
const MAX_LABEL = 80;

/**
 * What a control's label says it commits the user to, as the word that says so (`"Pay"`,
 * `"Place order"`), or undefined. Agents that drive a browser or desktop apps check the controls
 * they are about to use with it and stop for the user's approval, whatever the page told the
 * model. It errs towards ordinary browsing going on: a verb has to come first in a short label
 * ("Pay 1 290 kr", "Slett annonse"), or one of a few phrases appear in it ("Place order"); "Go
 * to payment", "Add to cart", "My bookings", "Search" and cookie banners don't count.
 */
export function consequentialLabel(label: string): string | undefined {
  // Icons and punctuation before the words, like "✓ Confirm" or "→ Send".
  const text = label
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  if (text === "" || text.length > MAX_LABEL || CONSENT.test(text)) return undefined;
  return FIRST.exec(text)?.[1] ?? ANYWHERE.exec(text)?.[1];
}
