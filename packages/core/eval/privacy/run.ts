// Privacy eval: how much the rules and the local model hide, how much they hide that the model
// needed, and how fast, across models, label sets, window sizes and thresholds.
// pnpm -C packages/core eval:privacy -- [--models prod,fp32] [--labels prod,core4] [--windows 0,64]
//   [--packs prod,0,100] [--thresholds prod,0.3,0.5] [--threads 4] [--grid] [--speed]
//   [--corpus chat-nb,tools]
// Needs `pnpm -C packages/core build` and the local model (nudge serve downloads it into
// server/models; or --model-dir). Each item runs the way a request does: a fresh vault holding
// the players' names, the local model over the pieces DeepScanner reads (not for web results),
// then the rules.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DeepScanner,
  localModelDir,
  piecesOf,
  quasiIdentifierDetectors,
  Vault,
} from "../../dist/index.js";
import type { DeepDetector } from "../../dist/index.js";
import { LABEL_KINDS } from "../../dist/privacy/deep/detector.js";
import { PACK_WORDS, THRESHOLDS } from "../../dist/privacy/deep/local-model.js";
import { NORWEGIAN_PLACES } from "../../dist/privacy/lists/places.js";
import { nameParts } from "../../dist/privacy/people.js";
import { type GlinerSpan, pack as packTexts, unpack } from "../../dist/privacy/deep/gliner.js";
import { loadModel } from "./model.ts";

type Tier = 1 | 2;
type Item = {
  id: string;
  source: string;
  lang: string;
  text: string;
  hide: [string, string, Tier][];
  keep: string[];
};

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    models: { type: "string", default: "prod" },
    labels: { type: "string", default: "prod" },
    windows: { type: "string", default: "0" },
    packs: { type: "string", default: "prod" },
    // "prod" is the per-kind thresholds Nudge uses (THRESHOLDS).
    thresholds: { type: "string", default: "prod,0.3,0.4,0.5,0.6,0.7" },
    threads: { type: "string", default: "4" },
    speed: { type: "boolean", default: false },
    grid: { type: "boolean", default: false },
    corpus: { type: "string" },
    "model-dir": { type: "string" },
    out: { type: "string", default: join(import.meta.dirname, ".eval") },
  },
});

const root = join(import.meta.dirname, "..", "..", "..", "..");
const prodDir = values["model-dir"] ?? localModelDir(join(root, "server", "models"));
const MODELS: Record<string, { dir: string; file?: string }> = {
  prod: { dir: prodDir },
  // The onnx-community export the prod model is made from, full precision and vocabulary.
  fp32: { dir: "/tmp/ner-spike/gm", file: "onnx/model.onnx" },
};
const PROD_LABELS = Object.keys(LABEL_KINDS);
const LABEL_SETS: Record<string, { labels: string[]; kinds: Record<string, string> }> = {
  prod: { labels: PROD_LABELS, kinds: LABEL_KINDS },
  core4: {
    labels: ["person", "street address", "location", "organization"],
    kinds: { person: "NAME", "street address": "ADDRESS", location: "PLACE", organization: "ORG" },
  },
  core5: {
    labels: ["person", "street address", "city", "location", "organization"],
    kinds: {
      person: "NAME",
      "street address": "ADDRESS",
      city: "PLACE",
      location: "PLACE",
      organization: "ORG",
    },
  },
  wide: {
    labels: [...PROD_LABELS, "town", "village", "clinic", "sports club", "first name"],
    kinds: {
      ...LABEL_KINDS,
      town: "PLACE",
      village: "PLACE",
      clinic: "ORG",
      "sports club": "ORG",
      "first name": "NAME",
    },
  },
};
const MIN_SCORE = 0.25;
/** Norwegian places are hidden on purpose (ADR 22); keep values that are one are counted apart. */
const PLACES = new Set(NORWEGIAN_PLACES.map((place: string) => place.toLowerCase()));
const isPlace = (value: string) =>
  PLACES.has(value.toLowerCase().replace(/ (?:stasjon|s)$/, "")) || PLACES.has(value.toLowerCase());
/** The household, protected by Nudge without detection, as `nameParts` of each player. */
const PLAYERS = ["Vegard Svendsen", "Ingrid Svendsen"];
const ASSISTANT = "Nudge";

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const corpusDir = join(import.meta.dirname, "corpus");
const wanted = values.corpus === undefined ? undefined : new Set(list(values.corpus));
const items: Item[] = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".json") && (wanted?.has(f.replace(/\.json$/, "")) ?? true))
  .sort()
  .flatMap((f) => JSON.parse(readFileSync(join(corpusDir, f), "utf8")) as Item[]);
for (const item of items)
  for (const value of [...item.hide.map((h) => h[0]), ...item.keep])
    if (!item.text.includes(value)) throw new Error(`${item.id}: "${value}" isn't in the text`);

const scanned = items.filter((item) => item.source !== "web");
const pieces = [...new Set(scanned.flatMap((item) => piecesOf(item.text)))];
const pieceWords = pieces.reduce((n, p) => n + p.split(/\s+/u).length, 0);
mkdirSync(values.out, { recursive: true });

// --- Matching -----------------------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Occurrences of `value` as a word (a possessive s counts), case as written. */
function count(text: string, value: string): number {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escape(value)}(?:s|'s|’s)?(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return [...text.matchAll(re)].length;
}
/** What of a hidden value is still readable: all of it, a part, or nothing. */
function leak(redacted: string, value: string, kind: string): "full" | "partial" | undefined {
  if (count(redacted, value) > 0) return "full";
  const parts =
    kind === "NAME"
      ? value.split(/[\s-]+/u).filter((p) => p.length >= 2)
      : kind === "ADDRESS"
        ? value
            .split(/\s+/u)
            .slice(0, 1)
            .filter((p) => /\p{L}{3}/u.test(p))
        : [];
  if (parts.length > 1 || kind === "ADDRESS")
    for (const part of parts) if (count(redacted, part) > 0) return "partial";
  return undefined;
}

// --- Running a configuration ---------------------------------------------------------------

type SpanCache = Map<string, GlinerSpan[]>;
type ItemResult = {
  id: string;
  source: string;
  redacted: string;
  leaks: { value: string; kind: string; tier: Tier; how: "full" | "partial" }[];
  lost: string[];
  extra: string[];
};

/** One threshold, or one per kind (`NAME`, `ADDRESS`, `PLACE`, `ORG`). */
type Threshold = number | Readonly<Record<string, number>>;

function cachedDetector(
  cache: SpanCache,
  kinds: Record<string, string>,
  threshold: Threshold,
): DeepDetector {
  const at = (kind: string) => (typeof threshold === "number" ? threshold : threshold[kind]!);
  return {
    id: "eval",
    async find(texts) {
      return texts.map((text) => {
        const spans = cache.get(text);
        if (spans === undefined) throw new Error(`Not read: ${text.slice(0, 40)}`);
        return spans.flatMap((span) => {
          const kind = kinds[span.label];
          return kind === undefined || span.score < at(kind)
            ? []
            : [{ start: span.start, end: span.end, kind, score: span.score }];
        });
      });
    },
  };
}

async function runItems(detector: DeepDetector | undefined): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const item of items) {
    const vault = new Vault();
    for (const player of PLAYERS) for (const part of nameParts(player)) vault.protect(part, "NAME");
    const seeded = vault.entries.length;
    if (detector !== undefined && item.source !== "web")
      await new DeepScanner({ detector, mode: "required", allow: [ASSISTANT] }).protectIn(
        [item.text],
        vault,
      );
    const redacted = vault.redact(item.text, quasiIdentifierDetectors);
    const leaks = item.hide.flatMap(([value, kind, tier]) => {
      const how = leak(redacted, value, kind);
      return how === undefined ? [] : [{ value, kind, tier, how }];
    });
    const lost = item.keep.filter((value) => count(redacted, value) < count(item.text, value));
    const hidden = item.hide.map(([value]) => value.toLowerCase());
    const extra = vault.entries
      .slice(seeded)
      .filter((entry) => item.text.toLowerCase().includes(entry.value.toLowerCase()))
      .filter((entry) => {
        const v = entry.value.toLowerCase();
        return !hidden.some((h) => h.includes(v) || v.includes(h));
      })
      .map((entry) => `${entry.value}/${entry.kind}`);
    results.push({ id: item.id, source: item.source, redacted, leaks, lost, extra });
  }
  return results;
}

type Row = {
  name: string;
  t1: number;
  t1Partial: number;
  t2: number;
  lost: number;
  lostPlaces: number;
  extra: number;
  msPerPiece?: number;
  msPer1kWords?: number;
  results: ItemResult[];
};

const totals = {
  t1: items.reduce((n, i) => n + i.hide.filter((h) => h[2] === 1).length, 0),
  t2: items.reduce((n, i) => n + i.hide.filter((h) => h[2] === 2).length, 0),
  keep: items.reduce((n, i) => n + i.keep.filter((v) => !isPlace(v)).length, 0),
  keepPlaces: items.reduce((n, i) => n + i.keep.filter(isPlace).length, 0),
};

function row(name: string, results: ItemResult[], timing?: { ms: number }): Row {
  const leaks = results.flatMap((r) => r.leaks);
  return {
    name,
    t1: leaks.filter((l) => l.tier === 1).length,
    t1Partial: leaks.filter((l) => l.tier === 1 && l.how === "partial").length,
    t2: leaks.filter((l) => l.tier === 2).length,
    lost: results.reduce((n, r) => n + r.lost.filter((v) => !isPlace(v)).length, 0),
    lostPlaces: results.reduce((n, r) => n + r.lost.filter(isPlace).length, 0),
    extra: results.reduce((n, r) => n + r.extra.length, 0),
    ...(timing === undefined
      ? {}
      : {
          msPerPiece: timing.ms / pieces.length,
          msPer1kWords: (timing.ms / pieceWords) * 1000,
        }),
    results,
  };
}

/**
 * Reads every piece once with the model; the time is the model's, tokenizing included. With
 * `pack`, an item's pieces go to the model together, up to `pack` words a call, one per line.
 */
async function readPieces(
  model: string,
  labels: string[],
  window: number,
  threads: number,
  pack = 0,
): Promise<{ cache: SpanCache; ms: number; rss: number }> {
  const loaded = await loadModel({
    ...MODELS[model]!,
    labels,
    threads,
    minScore: MIN_SCORE,
    ...(window > 0 ? { windowWords: window } : {}),
  });
  for (const piece of pieces.slice(0, 5)) await loaded.spans(piece);
  const cache: SpanCache = new Map();
  const start = performance.now();
  if (pack === 0) for (const piece of pieces) cache.set(piece, await loaded.spans(piece));
  else
    for (const item of scanned) {
      const own = [...new Set(piecesOf(item.text))].filter((piece) => !cache.has(piece));
      for (const packed of packTexts(own, pack))
        unpack(await loaded.spans(packed.text), packed, own).forEach((spans, n) =>
          cache.set(own[packed.members[n]!]!, spans),
        );
    }
  return { cache, ms: performance.now() - start, rss: process.memoryUsage().rss };
}

const pct = (n: number, of: number) => `${((100 * (of - n)) / of).toFixed(1)}%`;

const rows: Row[] = [row("rules only", await runItems(undefined))];
const threads = Number(values.threads);
console.log(
  `${items.length} items (${scanned.length} read by the model, ${pieces.length} pieces, ${pieceWords} words): ` +
    `${totals.t1} tier-1 and ${totals.t2} tier-2 values to hide, ${totals.keep} to keep`,
);

for (const model of list(values.models!))
  for (const labelSet of list(values.labels!))
    for (const window of list(values.windows!).map(Number))
      for (const pack of list(values.packs!).map((p) => (p === "prod" ? PACK_WORDS : Number(p)))) {
        const { labels, kinds } = LABEL_SETS[labelSet]!;
        const { cache, ms, rss } = await readPieces(model, labels, window, threads, pack);
        const name = `${model}/${labelSet}/w${window || "max"}${pack ? `/pack${pack}` : ""}`;
        console.log(
          `${name}: ${(ms / pieces.length).toFixed(1)} ms per piece, rss ${(rss / 2 ** 20).toFixed(0)} MB`,
        );
        for (const t of list(values.thresholds!)) {
          const threshold = t === "prod" ? THRESHOLDS : Number(t);
          rows.push(
            row(`${name}/t${t}`, await runItems(cachedDetector(cache, kinds, threshold)), { ms }),
          );
        }
      }

// Thresholds per kind for the first model and label set, keeping what no other beats on tier 1,
// tier 2 and keep lost together.
const grid: Row[] = [];
if (values.grid) {
  const model = list(values.models!)[0]!;
  const { labels, kinds } = LABEL_SETS[list(values.labels!)[0]!]!;
  const first = list(values.packs!)[0]!;
  const pack = first === "prod" ? PACK_WORDS : Number(first);
  const { cache } = await readPieces(model, labels, 0, threads, pack);
  const steps = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  for (const NAME of steps)
    for (const ADDRESS of [0.3, 0.5])
      for (const PLACE of steps)
        for (const ORG of steps)
          grid.push(
            row(
              `NAME ${NAME} ADDRESS ${ADDRESS} PLACE ${PLACE} ORG ${ORG}`,
              await runItems(cachedDetector(cache, kinds, { NAME, ADDRESS, PLACE, ORG })),
            ),
          );
  const beats = (a: Row, b: Row) =>
    a.t1 <= b.t1 &&
    a.t2 <= b.t2 &&
    a.lost <= b.lost &&
    (a.t1 < b.t1 || a.t2 < b.t2 || a.lost < b.lost);
  const front = grid
    .filter((r) => !grid.some((other) => beats(other, r)))
    .sort((a, b) => a.t1 - b.t1 || a.t2 - b.t2);
  grid.splice(0, grid.length, ...front);
  console.log("\nPer-kind thresholds no other beats:");
  for (const r of front)
    console.log(
      `  ${r.name}: tier 1 ${r.t1}, tier 2 ${r.t2}, keep lost ${r.lost}, extra ${r.extra}`,
    );
}

const speed: string[] = [];
if (values.speed) {
  speed.push(
    "| threads | labels | window | ms per piece | ms per 1k words |",
    "|---|---|---|---|---|",
  );
  for (const t of [1, 2, 4, 8])
    for (const labelSet of ["prod", "core4"])
      for (const window of [0, 64]) {
        const { ms } = await readPieces("prod", LABEL_SETS[labelSet]!.labels, window, t);
        speed.push(
          `| ${t} | ${labelSet} | ${window || "max"} | ${(ms / pieces.length).toFixed(1)} | ${((ms / pieceWords) * 1000).toFixed(0)} |`,
        );
        console.log(speed.at(-1));
      }
}

// --- Report -------------------------------------------------------------------------------

const table = [
  "| config | tier 1 leaked | of which partial | tier 2 leaked | tier 2 hidden | keep lost | places kept lost | extra hidden | ms/piece | ms/1k words |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.name} | ${r.t1}/${totals.t1} | ${r.t1Partial} | ${r.t2}/${totals.t2} | ${pct(r.t2, totals.t2)} | ${r.lost}/${totals.keep} | ${r.lostPlaces}/${totals.keepPlaces} | ${r.extra} | ${r.msPerPiece?.toFixed(1) ?? "–"} | ${r.msPer1kWords?.toFixed(0) ?? "–"} |`,
  ),
];
console.log(table.join("\n"));

const detail = (r: Row) => [
  `### ${r.name}`,
  "",
  "Leaked:",
  ...r.results.flatMap((x) =>
    x.leaks.map((l) => `- T${l.tier} ${l.how} \`${l.value}\` (${l.kind}) in ${x.id}`),
  ),
  "",
  "Keep lost:",
  ...r.results.flatMap((x) => x.lost.map((v) => `- \`${v}\` in ${x.id}`)),
  "",
  "Extra hidden:",
  ...r.results.flatMap((x) => (x.extra.length ? [`- ${x.id}: ${x.extra.join(", ")}`] : [])),
  "",
];
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const report = join(values.out, `report-${stamp}.md`);
writeFileSync(
  report,
  [
    `# Privacy eval ${stamp}`,
    "",
    `${items.length} items, ${pieces.length} pieces, threads ${threads}. Tier 1: ${totals.t1}, tier 2: ${totals.t2}, keep: ${totals.keep}.`,
    "",
    ...table,
    "",
    ...(speed.length ? ["## Speed", "", ...speed, ""] : []),
    ...(grid.length
      ? [
          `## Per-kind thresholds no other beats (pack ${list(values.packs!)[0]})`,
          "",
          "| thresholds | tier 1 | tier 2 | keep lost | extra |",
          "|---|---|---|---|---|",
          ...grid.map((r) => `| ${r.name} | ${r.t1} | ${r.t2} | ${r.lost} | ${r.extra} |`),
          "",
        ]
      : []),
    "## Details",
    "",
    ...rows.flatMap(detail),
  ].join("\n"),
);
writeFileSync(
  join(values.out, `results-${stamp}.json`),
  JSON.stringify(
    rows.map(({ results, ...r }) => ({ ...r, results })),
    null,
    1,
  ),
);
console.log(`\nReport: ${report}`);
