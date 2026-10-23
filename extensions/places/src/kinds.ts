/**
 * Kinds of place a reminder can be for, such as "any grocery store", by the words people use, in
 * English and Norwegian, and the OpenStreetMap tags (`key:value`) that mark them.
 */
export const KINDS: readonly {
  readonly words: readonly string[];
  readonly tags: readonly string[];
}[] = [
  {
    words: [
      "grocery store",
      "supermarket",
      "grocery",
      "food store",
      "butikk",
      "matbutikk",
      "dagligvare",
      "store",
      "shop",
    ],
    tags: ["shop:supermarket", "shop:convenience", "shop:grocery"],
  },
  { words: ["pharmacy", "chemist", "apotek"], tags: ["amenity:pharmacy", "shop:chemist"] },
  { words: ["bakery", "bakeri"], tags: ["shop:bakery"] },
  { words: ["liquor store", "wine monopoly", "vinmonopolet", "polet"], tags: ["shop:alcohol"] },
  {
    words: ["hardware store", "jernvare", "byggevare"],
    tags: ["shop:hardware", "shop:doityourself"],
  },
  { words: ["petrol station", "gas station", "bensinstasjon"], tags: ["amenity:fuel"] },
  {
    words: ["post office", "parcel pickup", "post", "pakkeutlevering"],
    tags: ["amenity:post_office"],
  },
  { words: ["library", "bibliotek"], tags: ["amenity:library"] },
  { words: ["gym", "treningssenter"], tags: ["leisure:fitness_centre"] },
  { words: ["cafe", "coffee shop", "kafé", "kafe"], tags: ["amenity:cafe"] },
  { words: ["bank", "atm", "minibank"], tags: ["amenity:bank", "amenity:atm"] },
  { words: ["florist", "blomsterbutikk"], tags: ["shop:florist"] },
  { words: ["bookshop", "bookstore", "bokhandel"], tags: ["shop:books"] },
  { words: ["electronics store", "elektronikk"], tags: ["shop:electronics"] },
  { words: ["sports shop", "sportsbutikk"], tags: ["shop:sports"] },
  { words: ["kiosk", "convenience store"], tags: ["shop:convenience", "shop:kiosk"] },
];

/** The kind `words` name, read loosely ("any grocery store", "a pharmacy"); undefined for none. */
export function kindOf(
  words: string,
): { readonly name: string; readonly tags: readonly string[] } | undefined {
  const plain = words
    .trim()
    .toLowerCase()
    .replace(/^(any|an|a|the|nearest|en|et|ei|hvilken som helst|nærmeste)\s+/u, "")
    .replace(/s$/u, "");
  for (const kind of KINDS)
    for (const word of kind.words)
      if (plain === word) return { name: kind.words[0]!, tags: kind.tags };
  return undefined;
}
