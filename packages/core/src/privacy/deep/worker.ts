/**
 * The child process that runs the GLiNER model, so its native runtime and memory stay out of the
 * server's. Started by `openLocalModel` with the model's directory, threads, lowest score and words
 * per call; answers `{ id, texts }` with `{ id, found }` (spans per text) or `{ id, error }`. Short
 * texts are read together, one per line.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LABEL_KINDS } from "./detector.ts";
import { decode, encode, type GlinerSpan, pack, splitWords, unpack } from "./gliner.ts";

type Request = { readonly id: number; readonly texts: readonly string[] };

const [dir = "", threads = "2", threshold = "0.5", packWords = "0"] = process.argv.slice(2);
const labels = Object.keys(LABEL_KINDS);

try {
  const ort = await import("onnxruntime-node");
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(join(dir, "tokenizer.json"), "utf8")),
    JSON.parse(await readFile(join(dir, "tokenizer_config.json"), "utf8")),
  );
  const ids = new Map<string, readonly number[]>();
  const tokenize = (word: string): readonly number[] => {
    const known = ids.get(word);
    if (known !== undefined) return known;
    const found = tokenizer.encode(word, { add_special_tokens: false }).ids;
    if (ids.size > 50_000) ids.clear();
    ids.set(word, found);
    return found;
  };
  const session = await ort.InferenceSession.create(join(dir, "model.onnx"), {
    intraOpNumThreads: Number(threads),
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  const int64 = (values: readonly number[], dims: number[]) =>
    new ort.Tensor(
      "int64",
      BigInt64Array.from(values, (v) => BigInt(v)),
      dims,
    );

  const find = async (text: string): Promise<GlinerSpan[]> => {
    const words = splitWords(text);
    const spans: GlinerSpan[] = [];
    // A text longer than the model takes goes in windows of what fits.
    for (let offset = 0; offset < words.length;) {
      const window = words.slice(offset);
      const inputs = encode(window, labels, tokenize);
      if (inputs.words === 0) {
        offset++;
        continue;
      }
      const n = inputs.inputIds.length;
      const spanCount = inputs.spanMask.length;
      const out = await session.run({
        input_ids: int64(inputs.inputIds, [1, n]),
        attention_mask: int64(inputs.attentionMask, [1, n]),
        words_mask: int64(inputs.wordsMask, [1, n]),
        text_lengths: int64([inputs.words], [1, 1]),
        span_idx: int64(inputs.spanIdx, [1, spanCount, 2]),
        span_mask: new ort.Tensor("bool", Uint8Array.from(inputs.spanMask, Number), [1, spanCount]),
      });
      const logits = out.logits!.data as Float32Array;
      spans.push(...decode(logits, window, inputs.words, labels, Number(threshold)));
      offset += inputs.words;
    }
    return spans;
  };

  let queue = Promise.resolve();
  process.on("message", (request: Request) => {
    queue = queue.then(async () => {
      try {
        const found: GlinerSpan[][] = [];
        for (const packed of pack(request.texts, Number(packWords)))
          found.push(...unpack(await find(packed.text), packed, request.texts));
        process.send!({ id: request.id, found });
      } catch (error) {
        process.send!({ id: request.id, error: (error as Error).message });
      }
    });
  });
  process.send!({ ready: true });
} catch (error) {
  process.send!({ failed: (error as Error).message });
  process.exitCode = 1;
  process.disconnect();
}
