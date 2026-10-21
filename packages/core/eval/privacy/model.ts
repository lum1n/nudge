// GLiNER in this process, as privacy/deep/worker.ts runs it, but with the labels, the words per
// window and the threads as settings, and every span kept down to `minScore` so a threshold can be
// applied afterwards: the overlap pass keeps spans in score order, so the spans kept at threshold
// t are exactly those kept at `minScore` that score t or more.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decode, encode, type GlinerSpan, splitWords } from "../../dist/privacy/deep/gliner.js";

export type ModelSettings = {
  /** Directory with model.onnx (or `file`), tokenizer.json and tokenizer_config.json. */
  readonly dir: string;
  readonly file?: string;
  readonly labels: readonly string[];
  /** Words per model call; the worker fits as many as 512 tokens take. */
  readonly windowWords?: number;
  readonly threads: number;
  readonly minScore: number;
};

export type LoadedModel = {
  spans(text: string): Promise<GlinerSpan[]>;
  /** Model calls made so far. */
  readonly calls: number;
};

export async function loadModel(settings: ModelSettings): Promise<LoadedModel> {
  const ort = await import("onnxruntime-node");
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(join(settings.dir, "tokenizer.json"), "utf8")),
    JSON.parse(await readFile(join(settings.dir, "tokenizer_config.json"), "utf8")),
  );
  const ids = new Map<string, readonly number[]>();
  const tokenize = (word: string): readonly number[] => {
    const known = ids.get(word);
    if (known !== undefined) return known;
    const found: readonly number[] = tokenizer.encode(word, { add_special_tokens: false }).ids;
    ids.set(word, found);
    return found;
  };
  const session = await ort.InferenceSession.create(
    join(settings.dir, settings.file ?? "model.onnx"),
    {
      intraOpNumThreads: settings.threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    },
  );
  const int64 = (values: readonly number[], dims: number[]) =>
    new ort.Tensor(
      "int64",
      BigInt64Array.from(values, (v) => BigInt(v)),
      dims,
    );
  let calls = 0;
  const windowWords = settings.windowWords ?? Number.POSITIVE_INFINITY;

  return {
    get calls() {
      return calls;
    },
    async spans(text) {
      const words = splitWords(text);
      const spans: GlinerSpan[] = [];
      for (let offset = 0; offset < words.length;) {
        const window = words.slice(offset, offset + windowWords);
        const inputs = encode(window, settings.labels, tokenize);
        if (inputs.words === 0) {
          offset++;
          continue;
        }
        const n = inputs.inputIds.length;
        const spanCount = inputs.spanMask.length;
        calls++;
        const out = await session.run({
          input_ids: int64(inputs.inputIds, [1, n]),
          attention_mask: int64(inputs.attentionMask, [1, n]),
          words_mask: int64(inputs.wordsMask, [1, n]),
          text_lengths: int64([inputs.words], [1, 1]),
          span_idx: int64(inputs.spanIdx, [1, spanCount, 2]),
          span_mask: new ort.Tensor("bool", Uint8Array.from(inputs.spanMask, Number), [
            1,
            spanCount,
          ]),
        });
        const logits = out.logits!.data as Float32Array;
        spans.push(...decode(logits, window, inputs.words, settings.labels, settings.minScore));
        offset += inputs.words;
      }
      return spans;
    },
  };
}
