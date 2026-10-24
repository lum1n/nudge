/** Letters NFKD leaves whole, spelled the way they are in plain ASCII. */
const SPELLED: Record<string, string> = {
  æ: "ae",
  Æ: "ae",
  ø: "o",
  Ø: "o",
  ß: "ss",
  ẞ: "ss",
  đ: "d",
  Đ: "d",
  ł: "l",
  Ł: "l",
  þ: "th",
  Þ: "th",
};

/**
 * What the assistant is called, as its address has it: lower case, dashes for the rest. A copy of
 * the CLI's (packages/cli/src/commands/setup-offer.ts); keep them giving the same slug.
 */
export function slugOf(name: string): string {
  return name
    .replace(/[æÆøØßẞđĐłŁþÞ]/gu, (letter) => SPELLED[letter]!)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
