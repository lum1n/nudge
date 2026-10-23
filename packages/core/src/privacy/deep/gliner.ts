/**
 * What a GLiNER span model (urchade/gliner_multi-v2.1, as onnx-community exports it) takes and
 * gives, without the runtime: words, the prompt of entity labels, span indices, and the decoding of
 * its logits back into character spans. Mirrors the `gliner` Python package (words split by
 * `WhitespaceTokenSplitter`, first-subtoken pooling, flat decoding).
 */

/** One word of the text and where it is. */
export type Word = { readonly text: string; readonly start: number; readonly end: number };

/** A run of words the model labelled, as characters of the text. */
export type GlinerSpan = {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly score: number;
};

/** Token ids of one word or label, without special tokens. */
export type WordTokenizer = (word: string) => readonly number[];

export type GlinerInputs = {
  readonly inputIds: readonly number[];
  readonly attentionMask: readonly number[];
  readonly wordsMask: readonly number[];
  /** The words that fit: the text's first `words` words. */
  readonly words: number;
  /** `[start, end]` per span, word indices, end inclusive; zeros where the span runs past the text. */
  readonly spanIdx: readonly number[];
  readonly spanMask: readonly boolean[];
};

export const MAX_WIDTH = 12;
const MAX_TOKENS = 512;
const CLS = 1;
const SEP = 2;
const ENT_TOKEN = "<<ENT>>";
const SEP_TOKEN = "<<SEP>>";

/** Words and single symbols, as the Python package splits them: `\w+(?:[-_]\w+)*|\S`. */
export function splitWords(text: string): Word[] {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}_]+(?:[-_][\p{L}\p{M}\p{N}_]+)*|\S/gu)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** The model's inputs for `words` and `labels`; words past the model's length are left out. */
export function encode(
  words: readonly Word[],
  labels: readonly string[],
  tokenize: WordTokenizer,
): GlinerInputs {
  const inputIds = [CLS];
  const wordsMask = [0];
  for (const label of labels) {
    inputIds.push(...tokenize(ENT_TOKEN), ...tokenize(label));
  }
  inputIds.push(...tokenize(SEP_TOKEN));
  while (wordsMask.length < inputIds.length) wordsMask.push(0);
  let fitted = 0;
  for (const word of words) {
    const ids = tokenize(word.text);
    if (ids.length === 0) continue;
    if (inputIds.length + ids.length + 1 > MAX_TOKENS) break;
    fitted++;
    ids.forEach((id, i) => {
      inputIds.push(id);
      wordsMask.push(i === 0 ? fitted : 0);
    });
  }
  inputIds.push(SEP);
  wordsMask.push(0);
  const spanIdx: number[] = [];
  const spanMask: boolean[] = [];
  for (let start = 0; start < fitted; start++) {
    for (let width = 0; width < MAX_WIDTH; width++) {
      const inside = start + width < fitted;
      spanIdx.push(inside ? start : 0, inside ? start + width : 0);
      spanMask.push(inside);
    }
  }
  return {
    inputIds,
    attentionMask: inputIds.map(() => 1),
    wordsMask,
    words: fitted,
    spanIdx,
    spanMask,
  };
}

/**
 * The spans whose score passes `threshold`, from logits shaped `[1, words, MAX_WIDTH, labels]`,
 * without overlaps: the highest score wins.
 */
export function decode(
  logits: Float32Array,
  words: readonly Word[],
  fitted: number,
  labels: readonly string[],
  threshold: number,
): GlinerSpan[] {
  const found: { start: number; end: number; label: number; score: number }[] = [];
  const classes = labels.length;
  for (let start = 0; start < fitted; start++) {
    for (let width = 0; width < MAX_WIDTH && start + width < fitted; width++) {
      for (let label = 0; label < classes; label++) {
        const logit = logits[(start * MAX_WIDTH + width) * classes + label]!;
        const score = 1 / (1 + Math.exp(-logit));
        if (score >= threshold) found.push({ start, end: start + width, label, score });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: typeof found = [];
  for (const span of found) {
    if (kept.some((other) => span.start <= other.end && other.start <= span.end)) continue;
    kept.push(span);
  }
  return kept
    .sort((a, b) => a.start - b.start)
    .map((span) => ({
      start: words[span.start]!.start,
      end: words[span.end]!.end,
      label: labels[span.label]!,
      score: span.score,
    }));
}

/** Texts read in one model call: one text a line, and where each starts. */
export type Pack = {
  readonly text: string;
  readonly members: readonly number[];
  readonly starts: readonly number[];
};

/**
 * Short texts together, up to `maxWords` words a call, one per line, so the model's fixed cost
 * per call is paid once for many lines. A longer text goes alone.
 */
export function pack(texts: readonly string[], maxWords: number): Pack[] {
  const packs: Pack[] = [];
  let members: number[] = [];
  let words = 0;
  const flush = () => {
    if (members.length === 0) return;
    const starts: number[] = [];
    let at = 0;
    for (const i of members) {
      starts.push(at);
      at += texts[i]!.length + 1;
    }
    packs.push({ text: members.map((i) => texts[i]).join("\n"), members, starts });
    members = [];
    words = 0;
  };
  texts.forEach((text, i) => {
    const count = splitWords(text).length;
    if (members.length > 0 && words + count > maxWords) flush();
    members.push(i);
    words += count;
  });
  flush();
  return packs;
}

/** The spans found in a pack, per text it holds; a span over a line break is cut there. */
export function unpack(
  spans: readonly GlinerSpan[],
  packed: Pack,
  texts: readonly string[],
): GlinerSpan[][] {
  return packed.members.map((i, n) => {
    const start = packed.starts[n]!;
    const end = start + texts[i]!.length;
    return spans
      .filter((span) => span.start < end && span.end > start)
      .map((span) => ({
        ...span,
        start: Math.max(span.start, start) - start,
        end: Math.min(span.end, end) - start,
      }));
  });
}
