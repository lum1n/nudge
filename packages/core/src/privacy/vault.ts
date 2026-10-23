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
  /**
   * Readable again (ADR 15): no longer hidden, but its placeholder, wherever it is still stored,
   * is put back in what the model sees.
   */
  readonly released?: true;
  /**
   * Another way the value behind this placeholder was written, such as `vegard` for `Vegard`: it
   * matches as that value and shares its owner and state, but comes back as written, so a round
   * trip gives the text back exactly.
   */
  readonly spellingOf?: string;
};

/** Placeholders look like `⟦EMAIL1⟧`: the brackets never occur in prose, Markdown or JSON. */
export const PLACEHOLDER = /⟦([A-Z]+)(\d+)⟧/g;
/** Longest placeholder text a stream may have cut in two: `⟦` + kind + number + `⟧`. */
export const MAX_PLACEHOLDER_LENGTH = 24;

const WORD = /[\p{L}\p{N}_]/u;
/** Kinds whose values may take a Norwegian possessive `s`, as in "Anns bil". */
const POSSESSIVE_KINDS = new Set(["NAME", "PLACE", "ORG", "ADDRESS"]);

/** The lookup key of a value: lower case, runs of whitespace as one space. */
export function vaultKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * Stable placeholders for personal values. Append-only: a value keeps its placeholder for the
 * life of the assistant, so the model's view and provider prompt caches stay consistent.
 * Matching is case-insensitive and treats runs of whitespace alike; each other way a value is
 * written gets a placeholder of its own (a spelling, see `VaultEntry.spellingOf`), so rehydration
 * gives back exactly what was replaced.
 */
export class Vault {
  private readonly byKey = new Map<string, VaultEntry>();
  private readonly releasedByKey = new Map<string, VaultEntry>();
  private readonly byPlaceholder = new Map<string, VaultEntry>();
  /** Per placeholder of a value: its other spellings, by how they are written. */
  private readonly spellings = new Map<string, Map<string, VaultEntry>>();
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
   * Protects a value the detectors would not find, such as a person's name, and gives its
   * placeholder as written (see `VaultEntry.spellingOf`). With `owner`, the value is that player's
   * alone from now on, also where it was shown before; a value someone else owns stays theirs.
   */
  protect(value: string, kind: string, owner?: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2)
      throw new Error("Refusing to protect a value shorter than two characters");
    if (!/^[A-Z]+$/.test(kind))
      throw new Error(`Placeholder kind must be upper-case letters, got "${kind}"`);
    const released = this.releasedByKey.get(vaultKey(trimmed));
    if (released !== undefined) {
      // Hidden again, under its old placeholder.
      const { released: _, ...hidden } = released;
      const entry = owner === undefined ? hidden : { ...hidden, owner };
      this.insert(entry);
      this.unsaved.push(entry);
      return this.placeholderAsWritten(entry, trimmed, true);
    }
    const existing = this.byKey.get(vaultKey(trimmed));
    if (existing !== undefined) {
      if (owner !== undefined && existing.owner === undefined) {
        const owned = { ...existing, owner };
        this.insert(owned);
        this.unsaved.push(owned);
      }
      return this.placeholderAsWritten(existing, trimmed, true);
    }
    const entry: VaultEntry = {
      value: trimmed,
      kind,
      placeholder: this.nextPlaceholder(kind),
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
    const entry = this.valueOf(placeholder);
    if (entry === undefined || entry.forgotten) return false;
    const tombstone: VaultEntry = {
      value: "",
      kind: entry.kind,
      placeholder: entry.placeholder,
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      forgotten: true,
    };
    this.byKey.delete(vaultKey(entry.value));
    this.insert(tombstone);
    this.unsaved.push(tombstone);
    // Its spellings go with it, so none of them stays stored.
    for (const spelling of this.spellings.get(entry.placeholder)?.values() ?? []) {
      const gone: VaultEntry = {
        value: "",
        kind: spelling.kind,
        placeholder: spelling.placeholder,
        spellingOf: entry.placeholder,
        forgotten: true,
      };
      this.insert(gone);
      this.unsaved.push(gone);
    }
    return true;
  }

  /**
   * Makes a value readable again: text no longer has it replaced, and its placeholder is put back
   * wherever it is still stored, the model's requests included. Owned and forgotten values can't
   * be released. False when there is nothing to release.
   */
  release(placeholder: string): boolean {
    const entry = this.valueOf(placeholder);
    if (entry === undefined || entry.forgotten || entry.released || entry.owner !== undefined)
      return false;
    const released: VaultEntry = { ...entry, released: true };
    this.insert(released);
    this.unsaved.push(released);
    return true;
  }

  /** Whether the vault hides `value` already. */
  knows(value: string): boolean {
    return this.byKey.has(vaultKey(value));
  }

  /** The placeholder `value` is hidden under; undefined when it isn't hidden. */
  placeholderOf(value: string): string | undefined {
    return this.byKey.get(vaultKey(value))?.placeholder;
  }

  /**
   * The entry behind a placeholder, forgotten ones included. A spelling comes with the owner and
   * state of the value it spells.
   */
  get(placeholder: string): VaultEntry | undefined {
    const entry = this.byPlaceholder.get(placeholder);
    if (entry?.spellingOf === undefined) return entry;
    const value = this.valueOf(placeholder);
    if (value === undefined || value === entry) return entry;
    return {
      ...value,
      value: value.forgotten ? "" : entry.value,
      placeholder: entry.placeholder,
      spellingOf: entry.spellingOf,
    };
  }

  /**
   * Replaces personal values with placeholders: first registers what the detectors find, then
   * replaces every known value. Deterministic for a given vault, and idempotent: placeholders in
   * the input are left as they are. Values found for the first time get `owner`, if given.
   */
  redact(text: string, detectors: readonly PiiDetector[], owner?: string): string {
    if (text === "") return text;
    return mapOutsidePlaceholders(this.withReleased(text), (segment) => {
      for (const span of pickSpans(segment, detectors)) {
        const value = segment.slice(span.start, span.end);
        // Only new values: an owner given here must not take a value others already saw.
        this.protect(value, span.kind, this.byKey.has(vaultKey(value)) ? undefined : owner);
      }
      return this.replaceKnown(segment);
    });
  }

  /** Puts the values back. Placeholders this vault does not know, or forgot, stay as they are. */
  rehydrate(text: string): string {
    if (!text.includes("⟦")) return text;
    return text.replace(PLACEHOLDER, (placeholder) => {
      const entry = this.get(placeholder);
      return entry === undefined || entry.forgotten ? placeholder : entry.value;
    });
  }

  /**
   * Puts back only the values `viewer` may see, as `showTo` decides: for what a player's turn or
   * decision acts on, such as a tool's arguments. Without a viewer, owned values stay placeholders.
   */
  rehydrateFor(viewer: string | undefined, text: string): string {
    if (!text.includes("⟦")) return text;
    return text.replace(PLACEHOLDER, (placeholder) =>
      this.visibleTo(viewer, placeholder)
        ? (this.byPlaceholder.get(placeholder)?.value ?? placeholder)
        : placeholder,
    );
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
      const entry = this.get(placeholder);
      if (entry === undefined || entry.forgotten) return placeholder;
      return entry.owner === undefined || entry.owner === viewer ? entry.value : placeholder;
    });
  }

  /** Whether `viewer` may see what is behind a placeholder. */
  visibleTo(viewer: string | undefined, placeholder: string): boolean {
    const entry = this.get(placeholder);
    return (
      entry !== undefined &&
      !entry.forgotten &&
      (entry.owner === undefined || entry.owner === viewer)
    );
  }

  /** Text with the placeholders of released values put back. */
  private withReleased(text: string): string {
    if (this.releasedByKey.size === 0 || !text.includes("⟦")) return text;
    return text.replace(PLACEHOLDER, (placeholder) => {
      const entry = this.get(placeholder);
      return entry?.released ? entry.value : placeholder;
    });
  }

  private hideOwned(text: string, viewer: string | undefined): string {
    let matcher = this.hiddenFrom.get(viewer);
    if (matcher === undefined) {
      const entries = [...this.byKey.entries()].filter(
        ([, entry]) => entry.owner !== undefined && entry.owner !== viewer,
      );
      matcher = entries.length === 0 ? null : matcherOf(entries);
      this.hiddenFrom.set(viewer, matcher);
    }
    if (matcher === null) return text;
    return text.replace(matcher, (match) => {
      const entry = this.byKey.get(vaultKey(match));
      return entry === undefined ? match : this.placeholderAsWritten(entry, match, false);
    });
  }

  private replaceKnown(text: string): string {
    if (this.byKey.size === 0) return text;
    this.matcher ??= matcherOf([...this.byKey.entries()]);
    return text.replace(this.matcher, (match) => {
      const entry = this.byKey.get(vaultKey(match));
      return entry === undefined ? match : this.placeholderAsWritten(entry, match, true);
    });
  }

  /** The value a placeholder stands for: its own entry, or the one it is a spelling of. */
  private valueOf(placeholder: string): VaultEntry | undefined {
    const entry = this.byPlaceholder.get(placeholder);
    if (entry?.spellingOf === undefined) return entry;
    return this.byPlaceholder.get(entry.spellingOf) ?? entry;
  }

  /**
   * The placeholder of `entry`'s value as `written`: the entry's own when written the same way,
   * else its spelling's, which `create` adds when there is none yet.
   */
  private placeholderAsWritten(entry: VaultEntry, written: string, create: boolean): string {
    if (written === entry.value) return entry.placeholder;
    const known = this.spellings.get(entry.placeholder)?.get(written);
    if (known !== undefined) return known.placeholder;
    if (!create) return entry.placeholder;
    const spelling: VaultEntry = {
      value: written,
      kind: entry.kind,
      placeholder: this.nextPlaceholder(entry.kind),
      spellingOf: entry.placeholder,
    };
    this.insert(spelling);
    this.unsaved.push(spelling);
    return spelling.placeholder;
  }

  private nextPlaceholder(kind: string): string {
    return `⟦${kind}${(this.counters.get(kind) ?? 0) + 1}⟧`;
  }

  private insert(entry: VaultEntry): void {
    const match = /^⟦([A-Z]+)(\d+)⟧$/.exec(entry.placeholder);
    if (match === null) throw new Error(`Malformed placeholder ${entry.placeholder}`);
    const [, kind = "", n = "0"] = match;
    if (entry.spellingOf !== undefined) {
      // Text matches the value it spells, so the matchers stay as they are.
      let spellings = this.spellings.get(entry.spellingOf);
      if (spellings === undefined) {
        spellings = new Map();
        this.spellings.set(entry.spellingOf, spellings);
      }
      const previous = this.byPlaceholder.get(entry.placeholder);
      if (previous !== undefined) spellings.delete(previous.value);
      if (!entry.forgotten) spellings.set(entry.value, entry);
      this.byPlaceholder.set(entry.placeholder, entry);
      this.counters.set(kind, Math.max(this.counters.get(kind) ?? 0, Number(n)));
      this.changes++;
      return;
    }
    const key = vaultKey(entry.value);
    // An entry's last state wins: a released value is no longer hidden, and the reverse.
    const previous = this.byPlaceholder.get(entry.placeholder);
    if (previous !== undefined && !previous.forgotten) {
      this.byKey.delete(vaultKey(previous.value));
      this.releasedByKey.delete(vaultKey(previous.value));
    }
    if (entry.released) this.releasedByKey.set(key, entry);
    else if (!entry.forgotten) this.byKey.set(key, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.counters.set(kind, Math.max(this.counters.get(kind) ?? 0, Number(n)));
    this.matcher = undefined;
    this.hiddenFrom.clear();
    this.changes++;
  }
}

/**
 * One alternation of the keys, longest first, so "Ann Berg" wins over "Ann". Each key carries its
 * own word boundaries, so where "Ann Berg" fails ("Ann Bergen") the regex falls back to "Ann".
 * Whitespace in a key matches any run of whitespace; names and places may take a possessive `s`.
 */
function matcherOf(entries: readonly (readonly [string, VaultEntry])[]): RegExp {
  return new RegExp(
    [...entries]
      .sort(([a], [b]) => b.length - a.length)
      .map(([key, entry]) => {
        const body = key
          .split(" ")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\s+");
        const before = WORD.test(key[0] ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
        const after = !WORD.test(key.at(-1) ?? "")
          ? ""
          : POSSESSIVE_KINDS.has(entry.kind)
            ? "(?=s?(?![\\p{L}\\p{N}_]))"
            : "(?![\\p{L}\\p{N}_])";
        return before + body + after;
      })
      .join("|"),
    "giu",
  );
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
