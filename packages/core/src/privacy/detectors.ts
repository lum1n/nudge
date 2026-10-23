import { domainDetector, ipDetector, usernameDetector } from "./hosts.ts";
import { addressDetector, nameDetector } from "./people.ts";
import { orgDetector, placeDetector } from "./places.ts";

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

const PHONE_CUE =
  /(?<![\p{L}])(?:tlf|tel|telefon|telefonnummer|telefonnummeret|nummer|nummeret|nr|mobil|mobilnummer|mobilnummeret|mob|phone|cell|mobile|call|ring|ringe|sms|text|vipps|vippse|whatsapp|kontakt)(?![\p{L}])[^\n\d]{0,30}?(?<![\p{N}+])(?<number>[2-9]\d{7})(?![\p{L}\p{N}])/giu;

/**
 * Norwegian eight-digit numbers written without spaces after a word that makes them a phone
 * number: "Mobil: 90512477", "ring 41234567", "nummeret er 48219553". Without such a word they stay
 * readable, as `phoneDetector` leaves them.
 */
export const phoneCueDetector: PiiDetector = {
  kind: "PHONE",
  *find(text) {
    for (const match of text.matchAll(PHONE_CUE)) {
      const number = match.groups!.number!;
      const start = match.index + match[0].length - number.length;
      yield { start, end: start + number.length };
    }
  },
};

/** IBANs, checked with mod 97. */
export const ibanDetector = regexDetector(
  "IBAN",
  /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/u,
  (match) => ibanValid(match.replace(/ /g, "")),
);

/**
 * Links: after a scheme (`https://`), after `www.`, or a host with a path (`nytimes.com/2026/…`),
 * up to the next space or quote.
 */
const LINK =
  /(?:(?<![\p{L}\p{N}])[a-z][a-z0-9+.-]*:\/\/|(?<![\p{L}\p{N}_@.-])www\.|(?<![\p{L}\p{N}_@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?=[/?#]))[^\s<>"'`]*/giu;

const CARD = regexDetector(
  "CARD",
  /(?<![\p{L}\p{N}])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}])/u,
  (match) => luhnValid(digits(match)),
);

/**
 * Payment card numbers, checked with Luhn. Digits in a link are left alone: one in ten long ids
 * passes Luhn, and an article's id in its address is not a card.
 */
export const cardDetector: PiiDetector = {
  kind: "CARD",
  *find(text) {
    const links = [...text.matchAll(LINK)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
    for (const span of CARD.find(text))
      if (!links.some((link) => span.start >= link.start && span.start < link.end)) yield span;
  },
};

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

/** Norwegian licence plates (`AB 12345`), leaving codes such as `EN 12345` and `NO 12345` alone. */
export const plateDetector = regexDetector(
  "PLATE",
  /(?<![\p{L}\p{N}])[A-Z]{2} ?\d{5}(?![\p{L}\p{N}])/u,
  (match) =>
    !["EN", "NO", "ID", "EU", "UK", "US", "PR", "NS", "IS", "ES"].includes(match.slice(0, 2)),
);

/** Vehicle identification numbers: 17 capitals and digits without I, O or Q, of both kinds. */
export const vinDetector = regexDetector(
  "VIN",
  /(?<![\p{L}\p{N}])[A-HJ-NPR-Z0-9]{17}(?![\p{L}\p{N}])/u,
  (match) => /[A-Z].*[A-Z]/.test(match) && /\d.*\d/.test(match),
);

const MONTHS =
  "januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|january|february|march|may|june|july|october|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|okt|oct|nov|des|dec";
const DATE = `\\d{1,2}\\.\\s?\\d{1,2}\\.\\s?(?:\\d{4}|\\d{2})|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.?\\s+(?:${MONTHS})\\.?(?:\\s+\\d{4})?|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?|\\d{1,2}/\\d{1,2}/\\d{2,4}`;
const BIRTH = new RegExp(
  `(?<![\\p{L}])(?:født|f\\.|fødselsdatoen|fødselsdato|fødselsdagen|fødselsdag|bursdagen|bursdag|born|dob|date of birth|birth date|birthday|birthdate)(?:\\s+(?:den|on|the|er|is|:))?[:\\s]+(?:[^\\n\\d]{0,12}?)(?<date>${DATE})(?![\\p{L}\\p{N}])`,
  "giu",
);
/** A list under a heading such as "Bursdager:", one person per line. */
const BIRTH_LIST =
  /(?<![\p{L}])(?:bursdager|bursdagar|fødselsdager|fødselsdatoer|birthdays|birth dates)[^\n]*:[ \t]*\n(?<lines>(?:[ \t]*[-*•][^\n]*(?:\n|$))+)/giu;
const DATES = new RegExp(`(?<![\\p{L}\\p{N}])(?:${DATE})(?![\\p{L}\\p{N}])`, "giu");

/**
 * Dates of birth: a date after "født", "bursdag", "born", "DOB" and the like, or in a list under
 * "Bursdager:" or "Birthdays:". Other dates stay.
 */
export const birthDateDetector: PiiDetector = {
  kind: "BIRTHDATE",
  *find(text) {
    for (const match of text.matchAll(BIRTH)) {
      const date = match.groups!.date!;
      const start = match.index + match[0].length - date.length;
      yield { start, end: start + date.length };
    }
    for (const list of text.matchAll(BIRTH_LIST)) {
      const lines = list.groups!.lines!;
      const offset = list.index + list[0].length - lines.length;
      for (const date of lines.matchAll(DATES))
        yield { start: offset + date.index, end: offset + date.index + date[0].length };
    }
  },
};

/**
 * Secrets that let someone act as their owner: keys and tokens of well-known formats, private key
 * blocks, JSON web tokens, bearer tokens, and what follows "password:" or "passord:".
 */
const SECRET = new RegExp(
  [
    // Provider keys: OpenAI and Anthropic, GitHub, GitLab, Slack, Stripe, Google, AWS, npm, HF.
    String.raw`(?<![\w-])(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|[rs]k_(?:live|test)_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})(?![\w-])`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
    String.raw`(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![\w-])`,
  ].join("|"),
  "g",
);
const SECRET_CUE =
  /(?<![\p{L}])(?:password|passwd|passord|pwd|passphrase|api[ _-]?key|secret|token|bearer)(?:\s+(?:is|er))?(?:\s*[:=]\s*|\s+)(?<secret>[^\s"'`]{6,})/giu;

export const secretDetector: PiiDetector = {
  kind: "SECRET",
  *find(text) {
    for (const match of text.matchAll(SECRET))
      yield { start: match.index, end: match.index + match[0].length };
    for (const match of text.matchAll(SECRET_CUE)) {
      const secret = match.groups!.secret!.replace(/[.,;:!?)]+$/u, "");
      // A word, not a secret: "the password is wrong", "token expired".
      if (!/\d|[^\p{L}\d]/u.test(secret)) continue;
      const start = match.index + match[0].length - match.groups!.secret!.length;
      yield { start, end: start + secret.length };
    }
  },
};

/**
 * The detectors every assistant runs: only what does harm on its own (ADR 15). Names, places,
 * organisations, hosts and the like stay readable; the detectors for them are here for the local
 * model and for hosts that want them.
 */
export const builtinDetectors: readonly PiiDetector[] = [
  secretDetector,
  emailDetector,
  ibanDetector,
  cardDetector,
  norwegianIdDetector,
  norwegianAccountDetector,
  phoneDetector,
  phoneCueDetector,
];

/** Everything ADR 14 hid: the built-in detectors and those for names, places and hosts. */
export const quasiIdentifierDetectors: readonly PiiDetector[] = [
  ...builtinDetectors,
  usernameDetector,
  domainDetector,
  ipDetector,
  plateDetector,
  vinDetector,
  birthDateDetector,
  addressDetector,
  orgDetector,
  placeDetector(),
  nameDetector(),
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
