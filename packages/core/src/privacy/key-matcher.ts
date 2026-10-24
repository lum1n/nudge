/**
 * Finds a vault's keys in text the way one `giu` alternation of their patterns would, in their
 * order, but with a trie of the case-folded keys: a vault of 10k values made that alternation take
 * seconds to compile and to run over a long history (`pnpm -C packages/core bench:redaction`).
 * The trie only proposes keys; each is confirmed with its own pattern (word boundaries,
 * possessive `s`), so what matches is exactly what the alternation matched.
 */
export class KeyMatcher {
  private readonly root: TrieNode = { next: new Map() };
  private readonly patterns: { readonly source: string; regex?: RegExp }[] = [];

  /**
   * `keys` in the order the alternation tries them, each with its pattern: a key is lower case,
   * one space between words, and its pattern matches it whatever the case, with any run of
   * whitespace for a space.
   */
  constructor(keys: readonly { readonly key: string; readonly source: string }[]) {
    keys.forEach(({ key, source }, rank) => {
      this.patterns.push({ source });
      let node = this.root;
      for (const char of key) {
        const edge = char === " " ? SPACE : fold(char.codePointAt(0)!);
        let next = node.next.get(edge);
        if (next === undefined) {
          next = { next: new Map() };
          node.next.set(edge, next);
        }
        node = next;
      }
      (node.ranks ??= []).push(rank);
    });
  }

  /** `text` with each match, leftmost first, replaced by what `change` makes of it. */
  replace(text: string, change: (match: string) => string): string {
    let result = "";
    let last = 0;
    for (let i = 0; i < text.length;) {
      const match = this.matchAt(text, i);
      if (match === undefined) {
        i += text.codePointAt(i)! > 0xffff ? 2 : 1;
        continue;
      }
      result += text.slice(last, i) + change(match);
      i += match.length;
      last = i;
    }
    return last === 0 ? text : result + text.slice(last);
  }

  /** The first key, in the alternation's order, whose pattern matches at `start`. */
  private matchAt(text: string, start: number): string | undefined {
    let candidates: number[] | undefined;
    let node: TrieNode | undefined = this.root;
    let i = start;
    while (i < text.length) {
      const code = text.codePointAt(i)!;
      if (isSpace(code)) {
        node = node.next.get(SPACE);
        if (node === undefined) break;
        // Whitespace in a key matches any run of it; no key goes on with whitespace.
        do i++;
        while (i < text.length && isSpace(text.charCodeAt(i)));
      } else {
        node = node.next.get(fold(code));
        if (node === undefined) break;
        i += code > 0xffff ? 2 : 1;
      }
      if (node.ranks !== undefined) (candidates ??= []).push(...node.ranks);
    }
    if (candidates === undefined) return undefined;
    candidates.sort((a, b) => a - b);
    for (const rank of candidates) {
      const pattern = this.patterns[rank]!;
      pattern.regex ??= new RegExp(pattern.source, "iuy");
      pattern.regex.lastIndex = start;
      const match = pattern.regex.exec(text);
      if (match !== null) return match[0];
    }
    return undefined;
  }
}

type TrieNode = { readonly next: Map<number, TrieNode>; ranks?: number[] };

/** The trie edge for whitespace in a key. */
const SPACE = -1;
const WHITESPACE = /\s/u;

function isSpace(code: number): boolean {
  if (code < 0x80) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return code <= 0xffff && WHITESPACE.test(String.fromCharCode(code));
}

/**
 * Characters `/…/iu` treats alike whose case mappings don't show it (each has a mapping of several
 * characters), found by checking every code point.
 */
const FOLD_EXCEPTIONS = new Map([
  [0x1fd3, 0x390],
  [0x1fe3, 0x3b0],
  [0xfb05, 0xfb06],
]);
const folded = new Map<number, number>();

/**
 * One code point for all that `/…/iu` matches alike, and at times for a few it doesn't (`ı` and
 * `i`), which the pattern then rules out.
 */
function fold(code: number): number {
  if (code < 0x80) return code >= 0x41 && code <= 0x5a ? code + 32 : code;
  let result = folded.get(code);
  if (result === undefined) {
    const char = String.fromCodePoint(code);
    result =
      FOLD_EXCEPTIONS.get(code) ??
      single(char.toUpperCase().toLowerCase()) ??
      single(char.toLowerCase()) ??
      code;
    folded.set(code, result);
  }
  return result;
}

function single(text: string): number | undefined {
  const code = text.codePointAt(0)!;
  return text.length === (code > 0xffff ? 2 : 1) ? code : undefined;
}
