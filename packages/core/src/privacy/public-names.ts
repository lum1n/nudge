import { PUBLIC_NAMES, PUBLIC_PLACES } from "./lists/public-names.ts";

const known = new Set(PUBLIC_NAMES.map((name) => key(name)));
const knownPlaces = new Set(PUBLIC_PLACES.map((name) => key(name)));

function key(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * Whether a name is so well known that hiding it only hurts: a famous person's full name, or a
 * company, brand, programme or landmark (Wikidata, `scripts/privacy-data.mjs`). For a `PLACE`, also
 * a country or a big city abroad.
 */
export function isPublicName(name: string, kind?: string): boolean {
  const k = key(name);
  return known.has(k) || (kind === "PLACE" && knownPlaces.has(k));
}

/**
 * A name without well-known names at either end: "IKEA Slependen" → "Slependen". Nothing when
 * what is left after the first is well known itself: "The New York" → "", not "New".
 */
export function withoutPublicEnds(name: string, kind?: string): string {
  let words = name.split(/\s+/u).filter((word) => word !== "");
  for (let n = words.length - 1; n >= 1; n--)
    if (isPublicName(words.slice(0, n).join(" "), kind)) {
      words = words.slice(n);
      break;
    }
  if (isPublicName(words.join(" "), kind)) return "";
  for (let n = words.length - 1; n >= 1; n--)
    if (isPublicName(words.slice(-n).join(" "), kind)) {
      words = words.slice(0, -n);
      break;
    }
  return words.join(" ");
}
