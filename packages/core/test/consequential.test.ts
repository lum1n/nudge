import { describe, expect, it } from "vitest";
import { consequentialLabel } from "../src/index.ts";

describe("consequentialLabel", () => {
  it.each([
    ["Pay 1 290 kr", "Pay"],
    ["Buy now", "Buy"],
    ["Purchase", "Purchase"],
    ["Book", "Book"],
    ["Reserve table", "Reserve"],
    ["Send", "Send"],
    ["Send message", "Send"],
    ["Submit", "Submit"],
    ["Delete account", "Delete"],
    ["Confirm and pay", "Confirm"],
    ["Publish", "Publish"],
    ["Post comment", "Post"],
    ["Register", "Register"],
    ["Subscribe", "Subscribe"],
    ["Unsubscribe", "Unsubscribe"],
    ["Donate 100 kr", "Donate"],
    ["Transfer", "Transfer"],
    ["Place order", "Place order"],
    ["Place your order", "Place your order"],
    ["Complete purchase", "Complete purchase"],
    ["Sign up for free", "Sign up"],
    ["Kjøp nå", "Kjøp"],
    ["Betal 349 kr", "Betal"],
    ["Bestill", "Bestill"],
    ["Slett annonse", "Slett"],
    ["Bekreft bestilling", "Bekreft"],
    ["Publiser", "Publiser"],
    ["Registrer deg", "Registrer"],
    ["Overfør", "Overfør"],
    ["Signer", "Signer"],
    ["Fullfør kjøp", "Fullfør"],
    ["Legg ut annonse", "Legg ut"],
    ["Meld deg på", "Meld deg på"],
    ["Send inn søknad", "Send"],
    // Icons and spacing before the words.
    ["✓  Confirm", "Confirm"],
    ["→ Send", "Send"],
  ])("%s commits the user", (label, word) => {
    expect(consequentialLabel(label)).toBe(word);
  });

  it.each([
    "Search",
    "Søk",
    "Next",
    "Neste",
    "Go to payment",
    "Gå til betaling",
    "Til kassen",
    "Add to cart",
    "Legg i handlekurv",
    "My bookings",
    "Mine bestillinger",
    "Bookmark",
    "Facebook",
    "Posts",
    "Postnummer",
    "Betaling",
    "Sending options",
    "Sign in",
    "Logg inn",
    "Logg ut",
    "Show more",
    "Filter",
    "Cancel",
    // Cookie and consent dialogs.
    "Confirm my choices",
    "Bekreft valg",
    "Accept all cookies",
    "Godta alle",
    "Confirm cookie preferences",
    "Bekreft personvernvalg",
    // Too long to be a button's words: a card or a paragraph.
    "Send us a message about anything at all and we will get back to you within two working days",
    "",
    "   ",
  ])("%j does not", (label) => {
    expect(consequentialLabel(label)).toBeUndefined();
  });
});
