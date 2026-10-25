import { PUBLIC_NAMES, PUBLIC_PLACES } from "./lists/public-names.ts";

/**
 * Brands and services the Wikidata list misses: too few Wikipedia languages ("Spond", "Matprat"),
 * or a single word that is also someone's name somewhere ("Kiwi", "Vipps", "Power", "Google").
 * Kept by hand. Not common Norwegian given names ("Oda", "Tine", "Finn") or places
 * ("Holmenkollen"), which may be someone's.
 */
const CURATED = [
  "Apotek 1",
  "Apple",
  "Aqara",
  "Autopass",
  "AWS",
  "Biltema",
  "Dekkmann",
  "EasyPark",
  "Elvia",
  "Felleskatalogen",
  "Fiken",
  "Finn.no",
  "Fremtind",
  "Google",
  "Grandiosa",
  "Hafslund",
  "Helsenorge",
  "Helthjem",
  "Hertz",
  "Instabox",
  "Instant Pot",
  "Interflora",
  "Jula",
  "Kiwi",
  "Matprat",
  "Maxbo",
  "Nordnet",
  "Philips Hue",
  "Postnord",
  "Power",
  "Prisjakt",
  "SAS",
  "Spleis",
  "Spond",
  "Søstrene Grene",
  "Talkmore",
  "Telia",
  "Tripletex",
  "Tryg",
  "VG",
  "Viaplay",
  "Vigilo",
  "Vipps",
  "Vy",
  "Wolt",
  "Yr",
];

const known = new Set([...PUBLIC_NAMES, ...CURATED].map((name) => key(name)));
const knownPlaces = new Set(PUBLIC_PLACES.map((name) => key(name)));

function key(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * Whether a name is so well known that hiding it only hurts: a famous person's full name, or a
 * company, brand, programme or landmark (Wikidata, `scripts/privacy-data.mjs`, and `CURATED`). For a `PLACE`, also
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
