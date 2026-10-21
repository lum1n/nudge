import { NORWEGIAN_PLACES } from "./lists/places.ts";
import type { PiiDetector, Span } from "./detectors.ts";

/**
 * Places so large that naming them says little about anyone; they stay readable unless written as
 * a station ("Oslo S").
 */
export const READABLE_PLACES: readonly string[] = ["Oslo", "Bergen", "Trondheim", "Stavanger"];

/** Words before a place: "i Sørumsand", "fra Ski", "near Moss". */
const LOCATIVE =
  /(?:^|[^\p{L}])(?:i|på|fra|til|ved|mot|nær|utenfor|gjennom|via|forbi|in|at|from|to|near|outside|via)\s+$/iu;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Norwegian places by name: kommuner, tettsteder and rail stations, in capitals as written.
 * Short names that are also words ("Ski", "Moss", "Hell", "Time") count only after a word such as
 * "i", "fra" or "near". A possessive `s` stays outside the span.
 */
export function placeDetector(readable: readonly string[] = READABLE_PLACES): PiiDetector {
  const open = new Set(readable.map((place) => place.toLowerCase()));
  const names = NORWEGIAN_PLACES.filter((name) => !open.has(name.toLowerCase())).sort(
    (a, b) => b.length - a.length,
  );
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_-])(?:${names.map(escape).join("|")})(?=s?(?![\\p{L}\\p{N}_-]))`,
    "gu",
  );
  return {
    kind: "PLACE",
    *find(text) {
      for (const match of text.matchAll(pattern)) {
        const name = match[0];
        if (
          name.length <= 4 &&
          !LOCATIVE.test(text.slice(Math.max(0, match.index - 12), match.index))
        )
          continue;
        yield { start: match.index, end: match.index + name.length };
      }
    },
  };
}

/** What a named place of care, school or club is, after its name: "Skogkanten Barnehage". */
const ORG_TYPES =
  "(?i:barnehagen?|barneskolen?|ungdomsskolen?|skolen?|skulen?|videregående|dyreklinikk(?:en)?|dyresykehus|veterinær(?:klinikk|kontor)?|legesenter(?:et)?|legekontor(?:et)?|tannlege(?:senter)?|tannklinikk|tannhelse|fysioterapi|kiropraktor|helsestasjon|sykehjem|menighet|idrettslag|kindergarten|preschool|school|clinic|veterinary)|VGS|SFO|AKS|IL|IF|FK|SK|AS|ASA|ANS|DA";
const TRAILING_TYPE = new RegExp(`^(.*?\\S)[ \\t]+(?:${ORG_TYPES})$`, "u");

/** An organisation's name without the kind of place after it: "Skogkanten Barnehage" → "Skogkanten". */
export function withoutOrgType(name: string): string {
  return TRAILING_TYPE.exec(name)?.[1] ?? name;
}

/** Capitalized words that start a phrase rather than a name: "Den barnehagen", "Our school". */
const NOT_NAMES = new Set(
  "den det de denne dette disse min mitt mine din ditt dine vår vårt våre hans hennes deres en ei et ny nye gamle hver alle ingen noen hvilken hvilke the a an my our your his her their this that every any some which new old".split(
    " ",
  ),
);
const CAP = "\\p{Lu}[\\p{L}'’-]*";
const ORG_BEFORE_TYPE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${CAP}(?:[ \\t]+${CAP}){0,2})[ \\t]+(?:${ORG_TYPES})(?![\\p{L}\\p{N}])`,
  "gu",
);
/** "avdeling Blåveisen", "avdelingene Blåveisen og Skogstjerna", "Blåveisen-avdelingen". */
const DEPARTMENT_AFTER = new RegExp(
  `(?<![\\p{L}])(?i:avdeling(?:en|ene)?|avd\\.|department|ward)[ \\t]+((?:${CAP})(?:(?:,[ \\t]*|[ \\t]+(?:og|and)[ \\t]+)${CAP})*)`,
  "gu",
);
const DEPARTMENT_BEFORE = new RegExp(`(?<![\\p{L}])(${CAP})-avdeling(?:en)?(?![\\p{L}])`, "gu");

/**
 * Organisations someone belongs to: the name before a kind of place ("Skogkanten Barnehage",
 * "Sørumsand IL", "Vethjem Dyreklinikk"), and departments ("avdeling Blåveisen"). The kind itself
 * stays readable, so the model still knows it is a kindergarten.
 */
export const orgDetector: PiiDetector = {
  kind: "ORG",
  *find(text) {
    const spans: Span[] = [];
    for (const match of text.matchAll(ORG_BEFORE_TYPE)) {
      const words = match[1]!.split(/[ \t]+/);
      // Drop leading words that start a phrase: "Den Skogkanten barnehage" → "Skogkanten".
      let skip = 0;
      while (skip < words.length && NOT_NAMES.has(words[skip]!.toLowerCase())) skip++;
      if (skip === words.length) continue;
      const name = words.slice(skip).join(" ");
      const start = match.index + match[1]!.indexOf(name);
      spans.push({ start, end: start + name.length });
    }
    for (const match of text.matchAll(DEPARTMENT_AFTER)) {
      const list = match[1]!;
      const offset = match.index + match[0].length - list.length;
      for (const part of list.matchAll(new RegExp(CAP, "gu"))) {
        if (NOT_NAMES.has(part[0].toLowerCase())) continue;
        spans.push({ start: offset + part.index, end: offset + part.index + part[0].length });
      }
    }
    for (const match of text.matchAll(DEPARTMENT_BEFORE))
      spans.push({ start: match.index, end: match.index + match[1]!.length });
    yield* spans.sort((a, b) => a.start - b.start);
  },
};
