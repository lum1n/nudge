import { defineNudgeExtension, type PiiDetector, type Span, Type } from "@nudge/core";
import { AMBIGUOUS, CUES, FIRST_NAMES, LAST_NAMES } from "./names.ts";

const VERSION = "0.1.0";

const Settings = Type.Object({
  names: Type.Boolean({
    default: true,
    description: "Find people's names in messages and keep them from the model.",
  }),
  addresses: Type.Boolean({
    default: true,
    description: "Find street addresses in messages and keep them from the model.",
  }),
  extraNames: Type.Array(Type.String(), {
    default: [],
    description: "More given names, family names or whole names to find, such as relatives'.",
  }),
});

/** A capitalized word: a letter in upper case, then letters, with hyphenated parts. */
const WORD = /\p{Lu}[\p{Ll}\p{Lu}'’]*(?:-\p{Lu}?[\p{Ll}'’]+)*/u;

/**
 * Finds people's names: capitalized words that are known given names, with the capitalized words
 * right after them as family names; known family names after a capitalized word; whole names from
 * `extra`; and a capitalized word after a greeting, sign-off or title.
 */
export function nameDetector(extra: readonly string[] = []): PiiDetector {
  const first = new Set(FIRST_NAMES);
  const last = new Set(LAST_NAMES);
  const whole: string[] = [];
  for (const name of extra) {
    const clean = name.trim();
    if (clean === "") continue;
    if (/\s/.test(clean)) whole.push(clean);
    else first.add(clean);
  }
  const cue = new RegExp(
    // Only the cue words ignore case; the name after them must be capitalized.
    `(?:^|[^\\p{L}])(?i:${CUES.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})[,:]?\\s+(${WORD.source}(?:[ \\t]+${WORD.source}){0,2})`,
    "gu",
  );
  const words = new RegExp(WORD.source, "gu");
  return {
    kind: "NAME",
    *find(text) {
      const spans: Span[] = [];
      for (const name of whole) {
        const pattern = new RegExp(
          `(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
          "gu",
        );
        for (const match of text.matchAll(pattern))
          spans.push({ start: match.index, end: match.index + match[0].length });
      }
      for (const match of text.matchAll(cue)) {
        const name = match[1]!;
        const start = match.index + match[0].length - name.length;
        spans.push({ start, end: start + name.length });
      }
      const tokens = [...text.matchAll(words)].map((m) => ({
        text: m[0],
        start: m.index,
        end: m.index + m[0].length,
      }));
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        // The words that follow it in a run, separated by single spaces only.
        let end = i;
        while (
          end + 1 < tokens.length &&
          text.slice(tokens[end]!.end, tokens[end + 1]!.start) === " " &&
          end - i < 2
        )
          end++;
        const isFirst = first.has(token.text) || first.has(token.text.split("-")[0]!);
        const next = tokens[i + 1];
        const hasFamily = end > i && next !== undefined;
        if (isFirst) {
          const startsSentence = /(^|[.!?:]\s*|\n\s*)$/.test(text.slice(0, token.start));
          // "Per dag" at a sentence's start is the word; "spør Per" mid-sentence is the name.
          if (AMBIGUOUS.has(token.text) && startsSentence && !hasFamily) continue;
          const stop = hasFamily ? tokens[end]! : token;
          spans.push({ start: token.start, end: stop.end });
          i = hasFamily ? end : i;
          continue;
        }
        // A known family name after a capitalized word that isn't a sentence's first: "Ivar Aasen".
        if (next !== undefined && end > i && last.has(next.text)) {
          const startsSentence = /(^|[.!?:]\s*|\n\s*)$/.test(text.slice(0, token.start));
          if (!startsSentence) {
            spans.push({ start: token.start, end: next.end });
            i++;
          }
        }
      }
      yield* merge(spans);
    },
  };
}

const STREET =
  "(?:gata|gaten|gate|veien|vegen|vei|veg|plassen|plass|allé|alle|stien|sti|bakken|svingen|terrassen|terrasse|torget|tunet|lia|haugen|kroken)";

/** Norwegian street addresses: `Storgata 5B`, `Kirkeveien 12`, with `, 0151 Oslo` when it follows. */
export const addressDetector: PiiDetector = (() => {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])\\p{Lu}[\\p{L}.-]*${STREET}\\s+\\d{1,4}(?: ?[A-Z]|[a-z])?(?:,?\\s+(?:H|U|K)\\d{4})?(?:,?\\s+\\d{4}\\s+\\p{Lu}[\\p{L}-]+)?(?![\\p{L}\\p{N}])`,
    "gu",
  );
  // Two words ("Kong Oscars gate 4", "Jens Bjelkes gate 12").
  const twoWords = new RegExp(
    `(?<![\\p{L}\\p{N}])\\p{Lu}[\\p{L}.-]*\\s+\\p{Lu}?[\\p{L}.-]*s?\\s+${STREET}\\s+\\d{1,4}(?: ?[A-Z]|[a-z])?(?:,?\\s+\\d{4}\\s+\\p{Lu}[\\p{L}-]+)?(?![\\p{L}\\p{N}])`,
    "gu",
  );
  return {
    kind: "ADDRESS",
    *find(text) {
      const spans: Span[] = [];
      for (const regex of [pattern, twoWords])
        for (const match of text.matchAll(regex))
          spans.push({ start: match.index, end: match.index + match[0].length });
      yield* merge(spans);
    },
  };
})();

/** Overlapping spans as one, in order. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last !== undefined && span.start < last.end)
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    else out.push(span);
  }
  return out;
}

export const nerExtension = defineNudgeExtension({
  name: "ner",
  version: VERSION,
  description:
    "Find people's names and street addresses the regular detectors miss, with name lists and rules on the host.",
  settings: Settings,
  setup: ({ settings }) => ({
    detectors: [
      ...(settings.names ? [nameDetector(settings.extraNames)] : []),
      ...(settings.addresses ? [addressDetector] : []),
    ],
  }),
});

export default nerExtension;
