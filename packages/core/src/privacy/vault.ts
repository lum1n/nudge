import type { PiiDetector, Span } from "./detectors.ts";

/** One protected value and the placeholder the model sees instead. */
export type VaultEntry = {
  /** Empty once forgotten. */
  readonly value: string;
  readonly kind: string;
  readonly placeholder: string;
  /** The player who alone may see the value; everyone else sees the placeholder. */
  readonly owner?: string;
  /** Dropped for good: the placeholder stays, so its number is never given to another value. */
  readonly forgotten?: true;
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
  /** Per viewer: what matches the values others own, null when there are none. */
  private readonly hiddenFrom = new Map<string | undefined, RegExp | null>();
  private changes = 0;

  constructor(entries: readonly VaultEntry[] = []) {
    for (const entry of entries) this.insert(entry);
  }

  get entries(): readonly VaultEntry[] {
    return [...this.byPlaceholder.values()];
  }

  /** Goes up with every change, so what was shown to someone can be worked out again. */
  get version(): number {
    return this.changes;
  }

  /** Entries added or changed since the last `takeUnsaved()`, for the caller to persist by placeholder. */
  takeUnsaved(): VaultEntry[] {
    const unsaved = this.unsaved;
    this.unsaved = [];
    return unsaved;
  }

  /** Restores entries that failed to persist, so the next save retries them. */
  returnUnsaved(entries: readonly VaultEntry[]): void {
    this.unsaved = [...entries, ...this.unsaved];
  }

  /**
   * Protects a value the detectors would not find, such as a person's name. With `owner`, the
   * value is that player's alone from now on, also where it was shown before; a value someone else
   * owns stays theirs.
   */
  protect(value: string, kind: string, owner?: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2)
      throw new Error("Refusing to protect a value shorter than two characters");
    if (!/^[A-Z]+$/.test(kind))
      throw new Error(`Placeholder kind must be upper-case letters, got "${kind}"`);
    const existing = this.byKey.get(trimmed.toLowerCase());
    if (existing !== undefined) {
      if (owner !== undefined && existing.owner === undefined) {
        const owned = { ...existing, owner };
        this.insert(owned);
        this.unsaved.push(owned);
      }
      return existing.placeholder;
    }
    const n = (this.counters.get(kind) ?? 0) + 1;
    const entry: VaultEntry = {
      value: trimmed,
      kind,
      placeholder: `⟦${kind}${n}⟧`,
      ...(owner === undefined ? {} : { owner }),
    };
    this.insert(entry);
    this.unsaved.push(entry);
    return entry.placeholder;
  }

  /**
   * Drops a value for good: from now on everyone, the model and tools only ever see its
   * placeholder. False when the vault doesn't hold it.
   */
  forget(placeholder: string): boolean {
    const entry = this.byPlaceholder.get(placeholder);
    if (entry === undefined || entry.forgotten) return false;
    const tombstone: VaultEntry = {
      value: "",
      kind: entry.kind,
      placeholder,
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      forgotten: true,
    };
    this.byKey.delete(entry.value.toLowerCase());
    this.insert(tombstone);
    this.unsaved.push(tombstone);
    return true;
  }

  /** The entry behind a placeholder, forgotten ones included. */
  get(placeholder: string): VaultEntry | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  /**
   * Replaces personal values with placeholders: first registers what the detectors find, then
   * replaces every known value. Deterministic for a given vault, and idempotent: placeholders in
   * the input are left as they are. Values found for the first time get `owner`, if given.
   */
  redact(text: string, detectors: readonly PiiDetector[], owner?: string): string {
    if (text === "") return text;
    return mapOutsidePlaceholders(text, (segment) => {
      for (const span of pickSpans(segment, detectors)) {
        const value = segment.slice(span.start, span.end);
        // Only new values: an owner given here must not take a value others already saw.
        this.protect(
          value,
          span.kind,
          this.byKey.has(value.trim().toLowerCase()) ? undefined : owner,
        );
      }
      return this.replaceKnown(segment);
    });
  }

  /** Puts the values back. Placeholders this vault does not know, or forgot, stay as they are. */
  rehydrate(text: string): string {
    if (!text.includes("⟦")) return text;
    return text.replace(PLACEHOLDER, (placeholder) => {
      const entry = this.byPlaceholder.get(placeholder);
      return entry === undefined || entry.forgotten ? placeholder : entry.value;
    });
  }

  /**
   * Text as `viewer` may see it: values someone else owns become their placeholders, also where
   * they are written out, and placeholders of values the viewer may see are put back. Without a
   * viewer, every owned value is hidden.
   */
  showTo(viewer: string | undefined, text: string): string {
    if (text === "") return text;
    const hidden = mapOutsidePlaceholders(text, (segment) => this.hideOwned(segment, viewer));
    if (!hidden.includes("⟦")) return hidden;
    return hidden.replace(PLACEHOLDER, (placeholder) => {
      const entry = this.byPlaceholder.get(placeholder);
      if (entry === undefined || entry.forgotten) return placeholder;
      return entry.owner === undefined || entry.owner === viewer ? entry.value : placeholder;
    });
  }

  /** Whether `viewer` may see what is behind a placeholder. */
  visibleTo(viewer: string | undefined, placeholder: string): boolean {
    const entry = this.byPlaceholder.get(placeholder);
    return (
      entry !== undefined &&
      !entry.forgotten &&
      (entry.owner === undefined || entry.owner === viewer)
    );
  }

  private hideOwned(text: string, viewer: string | undefined): string {
    let matcher = this.hiddenFrom.get(viewer);
    if (matcher === undefined) {
      const keys = [...this.byKey.entries()].flatMap(([key, entry]) =>
        entry.owner !== undefined && entry.owner !== viewer ? [key] : [],
      );
      matcher = keys.length === 0 ? null : matcherOf(keys);
      this.hiddenFrom.set(viewer, matcher);
    }
    if (matcher === null) return text;
    return replaceWords(text, matcher, (match) => this.byKey.get(match.toLowerCase())?.placeholder);
  }

  private replaceKnown(text: string): string {
    if (this.byKey.size === 0) return text;
    this.matcher ??= matcherOf([...this.byKey.keys()]);
    return replaceWords(
      text,
      this.matcher,
      (match) => this.byKey.get(match.toLowerCase())?.placeholder,
    );
  }

  private insert(entry: VaultEntry): void {
    const match = /^⟦([A-Z]+)(\d+)⟧$/.exec(entry.placeholder);
    if (match === null) throw new Error(`Malformed placeholder ${entry.placeholder}`);
    const [, kind = "", n = "0"] = match;
    if (!entry.forgotten) this.byKey.set(entry.value.toLowerCase(), entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.counters.set(kind, Math.max(this.counters.get(kind) ?? 0, Number(n)));
    this.matcher = undefined;
    this.hiddenFrom.clear();
    this.changes++;
  }
}

/** One alternation of `keys`, longest first, so "Ann Berg" wins over "Ann". */
function matcherOf(keys: readonly string[]): RegExp {
  return new RegExp(
    [...keys]
      .sort((a, b) => b.length - a.length)
      .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "giu",
  );
}

/** Replaces whole-word matches of `matcher` with what `replace` gives, or leaves them. */
function replaceWords(
  text: string,
  matcher: RegExp,
  replace: (match: string) => string | undefined,
): string {
  return text.replace(matcher, (match, offset: number) => {
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
    return replace(match) ?? match;
  });
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
