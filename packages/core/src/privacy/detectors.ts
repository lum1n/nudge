/** A run of text a detector found: `text.slice(start, end)` is the personal value. */
export type Span = { readonly start: number; readonly end: number };

/** Finds one kind of personal data. `kind` is upper-case letters only; it names the placeholder, as in `⟦EMAIL1⟧`. */
export type PiiDetector = {
  readonly kind: string;
  find(text: string): Iterable<Span>;
};

/** A detector from a regular expression, with an optional check on each match to drop false positives. */
export function regexDetector(
  kind: string,
  pattern: RegExp,
  valid: (match: string) => boolean = () => true,
): PiiDetector {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return {
    kind,
    *find(text) {
      for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
        if (valid(match[0])) yield { start: match.index, end: match.index + match[0].length };
      }
    },
  };
}

const digits = (text: string) => text.replace(/\D/g, "");

export const emailDetector = regexDetector(
  "EMAIL",
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u,
);

/**
 * Phone numbers with a country code (`+47 912 34 567`, `+1 (555) 010-9999`), and Norwegian
 * eight-digit numbers written in groups (`912 34 567`, `91 23 45 67`). An unbroken run of digits
 * without a country code is left alone: it is more often an amount or an order number.
 */
export const phoneDetector = regexDetector(
  "PHONE",
  /(?<![\p{L}\p{N}+])(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d(?:[ .-]?\d){5,13}|\d{3} \d{2} \d{3}|\d{2} \d{2} \d{2} \d{2})(?![\p{L}\p{N}])/u,
  (match) => digits(match).length >= 8,
);

/** IBANs, checked with mod 97. */
export const ibanDetector = regexDetector(
  "IBAN",
  /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/u,
  (match) => ibanValid(match.replace(/ /g, "")),
);

/** Payment card numbers, checked with Luhn. */
export const cardDetector = regexDetector(
  "CARD",
  /(?<![\p{L}\p{N}])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}])/u,
  (match) => luhnValid(digits(match)),
);

/** Norwegian national identity numbers (fødselsnummer, D-nummer), checked with both control digits. */
export const norwegianIdDetector = regexDetector(
  "NATIONALID",
  /(?<![\p{L}\p{N}])\d{6} ?\d{5}(?![\p{L}\p{N}])/u,
  (match) => fodselsnummerValid(digits(match)),
);

/** Norwegian bank account numbers written `1234.56.78903` or `1234 56 78903`, checked with mod 11. */
export const norwegianAccountDetector = regexDetector(
  "ACCOUNT",
  /(?<![\p{L}\p{N}])\d{4}[. ]\d{2}[. ]\d{5}(?![\p{L}\p{N}])/u,
  (match) => accountValid(digits(match)),
);

/** The detectors every assistant runs. Names come from the directory, not from a detector. */
export const builtinDetectors: readonly PiiDetector[] = [
  emailDetector,
  ibanDetector,
  cardDetector,
  norwegianIdDetector,
  norwegianAccountDetector,
  phoneDetector,
];

export function luhnValid(number: string): boolean {
  if (number.length < 13 || number.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= "A" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function mod11(digits: string, weights: readonly number[]): number | undefined {
  const sum = weights.reduce((total, weight, i) => total + weight * Number(digits[i]), 0);
  const control = 11 - (sum % 11);
  if (control === 11) return 0;
  return control === 10 ? undefined : control;
}

export function fodselsnummerValid(number: string): boolean {
  if (!/^\d{11}$/.test(number)) return false;
  let day = Number(number.slice(0, 2));
  const month = Number(number.slice(2, 4));
  if (day > 40) day -= 40; // D-nummer
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  const k1 = mod11(number, [3, 7, 6, 1, 8, 9, 4, 5, 2]);
  const k2 = mod11(number, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
  return k1 === Number(number[9]) && k2 === Number(number[10]);
}

export function accountValid(number: string): boolean {
  if (!/^\d{11}$/.test(number)) return false;
  return mod11(number, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) === Number(number[10]);
}
