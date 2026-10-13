import type { PiiDetector, Span } from "./detectors.ts";

/** One protected value and the placeholder the model sees instead. */
export type VaultEntry = {
  readonly value: string;
  readonly kind: string;
  readonly placeholder: string;
};

/** Placeholders look like `⟦EMAIL1⟧`: the brackets never occur in prose, Markdown or JSON. */
export const PLACEHOLDER = /⟦([A-Z]+)(\d+)⟧/g;
/** Longest placeholder text a stream may have cut in two: `⟦` + kind + number + `⟧`. */
export const MAX_PLACEHOLDER_LENGTH = 24;

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Stable placeholders for personal values. Append-only: a value keeps its placeholder for the
 * life of the assistant, so the model's view and provider prompt caches stay consistent.
 * Matching is case-insensitive; rehydration returns the value as first seen.
 */
export class Vault {
  private readonly byKey = new Map<string, VaultEntry>();
  private readonly byPlaceholder = new Map<string, VaultEntry>();
  private readonly counters = new Map<string, number>();
  private unsaved: VaultEntry[] = [];
  private matcher: RegExp | undefined;

  constructor(entries: readonly VaultEntry[] = []) {
    for (const entry of entries) this.insert(entry);
  }

  get entries(): readonly VaultEntry[] {
    return [...this.byPlaceholder.values()];
  }

  /** Entries added since the last `takeUnsaved()`, for the caller to persist. */
  takeUnsaved(): VaultEntry[] {
    const unsaved = this.unsaved;
    this.unsaved = [];
    return unsaved;
  }

  /** Restores entries that failed to persist, so the next save retries them. */
  returnUnsaved(entries: readonly VaultEntry[]): void {
    this.unsaved = [...entries, ...this.unsaved];
  }

  /** Protects a value the detectors would not find, such as a person's name. */
  protect(value: string, kind: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2)
      throw new Error("Refusing to protect a value shorter than two characters");
    if (!/^[A-Z]+$/.test(kind))
      throw new Error(`Placeholder kind must be upper-case letters, got "${kind}"`);
    const existing = this.byKey.get(trimmed.toLowerCase());
    if (existing !== undefined) return existing.placeholder;
    const n = (this.counters.get(kind) ?? 0) + 1;
    const entry = { value: trimmed, kind, placeholder: `⟦${kind}${n}⟧` };
    this.insert(entry);
    this.unsaved.push(entry);
    return entry.placeholder;
  }

  /**
   * Replaces personal values with placeholders: first registers what the detectors find, then
   * replaces every known value. Deterministic for a given vault, and idempotent: placeholders in
   * the input are left as they are.
   */
  redact(text: string, detectors: readonly PiiDetector[]): string {
    if (text === "") return text;
    return mapOutsidePlaceholders(text, (segment) => {
      for (const span of pickSpans(segment, detectors))
        this.protect(segment.slice(span.start, span.end), span.kind);
      return this.replaceKnown(segment);
    });
  }

  /** Puts the values back. Placeholders this vault does not know stay as they are. */
  rehydrate(text: string): string {
    if (!text.includes("⟦")) return text;
    return text.replace(
      PLACEHOLDER,
      (placeholder) => this.byPlaceholder.get(placeholder)?.value ?? placeholder,
    );
  }

  private replaceKnown(text: string): string {
    if (this.byKey.size === 0) return text;
    this.matcher ??= new RegExp(
      [...this.byKey.keys()]
        .sort((a, b) => b.length - a.length)
        .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "giu",
    );
    return text.replace(this.matcher, (match, offset: number) => {
      // Whole words only: "Ann" must not eat the start of "Anniversary".
      const before = text[offset - 1];
      const after = text[offset + match.length];
      const startsWord = WORD.test(match[0] ?? "");
      const endsWord = WORD.test(match.at(-1) ?? "");
      if (
        (startsWord && before !== undefined && WORD.test(before)) ||
        (endsWord && after !== undefined && WORD.test(after))
      ) {
        return match;
      }
      return this.byKey.get(match.toLowerCase())?.placeholder ?? match;
    });
  }

  private insert(entry: VaultEntry): void {
    const match = /^⟦([A-Z]+)(\d+)⟧$/.exec(entry.placeholder);
    if (match === null) throw new Error(`Malformed placeholder ${entry.placeholder}`);
    const [, kind = "", n = "0"] = match;
    this.byKey.set(entry.value.toLowerCase(), entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.counters.set(kind, Math.max(this.counters.get(kind) ?? 0, Number(n)));
    this.matcher = undefined;
  }
}

/** Applies `change` to the text between placeholders, leaving the placeholders untouched. */
function mapOutsidePlaceholders(text: string, change: (segment: string) => string): string {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    result += change(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + change(text.slice(last));
}

/** Detector spans without overlaps: earlier first, then longer, then the earlier detector. */
function pickSpans(text: string, detectors: readonly PiiDetector[]): (Span & { kind: string })[] {
  const spans: (Span & { kind: string; rank: number })[] = [];
  detectors.forEach((detector, rank) => {
    for (const span of detector.find(text)) {
      if (span.end - span.start >= 2) spans.push({ ...span, kind: detector.kind, rank });
    }
  });
  spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.rank - b.rank);
  const picked: (Span & { kind: string })[] = [];
  let end = 0;
  for (const span of spans) {
    if (span.start < end) continue;
    picked.push(span);
    end = span.end;
  }
  return picked;
}

/**
 * Drops an unfinished placeholder from the end of streamed text, so `⟦NA` never shows before
 * `ME1⟧` arrives and the value can be put back.
 */
export function withoutPartialPlaceholder(text: string): string {
  const open = text.lastIndexOf("⟦");
  if (open === -1 || text.indexOf("⟧", open) !== -1) return text;
  if (text.length - open > MAX_PLACEHOLDER_LENGTH) return text;
  return /^⟦[A-Z]*\d*$/.test(text.slice(open)) ? text.slice(0, open) : text;
}
