import type { PiiDetector, Span } from "@nudge/core";
import type { Contact } from "./vcard.ts";

const WORD = /[\p{L}\p{M}\p{N}]+(?:['’.-][\p{L}\p{M}\p{N}]+)*/gu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
/** A run of digits with spaces, dots, dashes or brackets between them, maybe after `+`. */
const NUMBER = /(?<![\p{L}\p{N}+])\+?\(?\d(?:[ .\-()]{0,2}\d)*(?![\p{L}\p{N}])/gu;
/** Fewer digits than this is an extension or a short number, too easily something else. */
const MIN_DIGITS = 7;

export type KnownOptions = {
  /** Hide people's whole names; e-mail addresses and phone numbers are hidden either way. */
  readonly names: boolean;
  /** Names that stay readable, lower-case, such as players' display names. */
  readonly readable: ReadonlySet<string>;
};

/**
 * The names, e-mail addresses and phone numbers in the address books, as detectors: wherever one
 * shows up in text on its way to the model, it is hidden like a found e-mail address. A name is
 * only hidden whole and with at least two words, so a contact called "Mom" or "Post" leaves those
 * words readable; companies' names stay readable as organisations do (ADR 15).
 */
export class KnownContacts {
  /** Whole names by their first word, as lower-case words. */
  private names = new Map<string, string[][]>();
  private emails = new Set<string>();
  /** Digits of each phone number, also without its country code and with a trunk `0`. */
  private phones = new Set<string>();

  /** `onUse` runs on every search, such as to refresh contacts that are getting old. */
  constructor(private readonly onUse: () => void = () => {}) {}

  set(contacts: readonly Contact[], options: KnownOptions): void {
    const names = new Map<string, string[][]>();
    const emails = new Set<string>();
    const phones = new Set<string>();
    for (const contact of contacts) {
      if (options.names && contact.company !== true) {
        const whole = [contact.name];
        if (contact.given && contact.family) whole.push(`${contact.given} ${contact.family}`);
        for (const name of whole) {
          if (options.readable.has(name.trim().toLowerCase())) continue;
          const words = wordsOf(name);
          if (words.length < 2) continue;
          const first = words[0]!;
          const known = names.get(first) ?? [];
          if (!known.some((other) => other.join(" ") === words.join(" "))) known.push(words);
          names.set(first, known);
        }
      }
      for (const { value } of contact.emails) emails.add(value.toLowerCase());
      for (const { value } of contact.phones)
        for (const digits of phoneKeys(value)) phones.add(digits);
    }
    this.names = names;
    this.emails = emails;
    this.phones = phones;
  }

  /** Whether a contact's whole name is `name`, as the detectors would hide it. */
  hides(name: string): boolean {
    const words = wordsOf(name);
    return (this.names.get(words[0] ?? "") ?? []).some(
      (other) => other.join(" ") === words.join(" "),
    );
  }

  readonly detectors: readonly PiiDetector[] = [
    { kind: "NAME", find: (text) => this.findNames(text) },
    { kind: "EMAIL", find: (text) => this.findEmails(text) },
    { kind: "PHONE", find: (text) => this.findPhones(text) },
  ];

  private findNames(text: string): Span[] {
    this.onUse();
    if (this.names.size === 0) return [];
    const words = [...text.matchAll(WORD)].map((m) => ({
      word: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    }));
    const spans: Span[] = [];
    for (let i = 0; i < words.length; i++) {
      const candidates = this.names.get(words[i]!.word);
      if (candidates === undefined) continue;
      // The longest name that goes on here, its words apart only by whitespace.
      let longest = 0;
      for (const name of candidates) {
        if (name.length <= longest || i + name.length > words.length) continue;
        let fits = true;
        for (let k = 1; k < name.length && fits; k++) {
          const word = words[i + k]!;
          fits =
            word.word === name[k] && /^\s+$/.test(text.slice(words[i + k - 1]!.end, word.start));
        }
        if (fits) longest = name.length;
      }
      if (longest === 0) continue;
      spans.push({ start: words[i]!.start, end: words[i + longest - 1]!.end });
      i += longest - 1;
    }
    return spans;
  }

  private findEmails(text: string): Span[] {
    if (this.emails.size === 0) return [];
    return [...text.matchAll(EMAIL)]
      .filter((m) => this.emails.has(m[0].toLowerCase()))
      .map((m) => ({ start: m.index, end: m.index + m[0].length }));
  }

  private findPhones(text: string): Span[] {
    if (this.phones.size === 0) return [];
    const spans: Span[] = [];
    for (const match of text.matchAll(NUMBER)) {
      const run = match[0];
      if (this.phones.has(numberKey(run))) {
        spans.push({ start: match.index, end: match.index + run.length });
        continue;
      }
      // Numbers written next to each other run together: from each group on, the longest
      // stretch of whole groups that is a known number.
      const groups = [...run.matchAll(/\+?\(?\d+\)?/g)];
      if (groups.length < 2 || groups.length > 16) continue;
      for (let first = 0; first < groups.length; first++)
        for (let last = groups.length - 1; last >= first; last--) {
          const start = groups[first]!.index;
          const end = groups[last]!.index + groups[last]![0].length;
          if (!this.phones.has(numberKey(run.slice(start, end)))) continue;
          spans.push({ start: match.index + start, end: match.index + end });
          first = last;
          break;
        }
    }
    return spans;
  }
}

function wordsOf(name: string): string[] {
  return [...name.matchAll(WORD)].map((m) => m[0].toLowerCase());
}

/** How a number in text is looked up: its digits, `+` and `00` dropped. */
function numberKey(text: string): string {
  const digits = text.replace(/\D/g, "");
  return text.trim().startsWith("+") ? digits : digits.replace(/^00/, "");
}

/**
 * The ways a contact's number may be written: as stored, and for one with a country code also
 * without it, with or without the trunk `0` (`+47 912 34 567`, `912 34 567`; `+44 7700 900123`,
 * `07700 900123`). The country code is one to three digits; each length is tried.
 */
export function phoneKeys(value: string): string[] {
  const key = numberKey(value);
  if (key.length < MIN_DIGITS) return [];
  const keys = new Set([key]);
  const international = /^\s*(?:\+|00)/.test(value);
  if (international)
    for (let code = 1; code <= 3; code++) {
      const national = key.slice(code);
      if (national.length < MIN_DIGITS) break;
      keys.add(national);
      keys.add(`0${national}`);
    }
  else if (key.startsWith("0") && key.length > MIN_DIGITS) keys.add(key.slice(1));
  return [...keys];
}
