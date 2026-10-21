import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { READABLE_PLACES, withoutOrgType } from "../places.ts";
import { type Vault, vaultKey } from "../vault.ts";
import { type DeepDetector, DeepUnavailable } from "./detector.ts";

/**
 * Whether requests need the local model: `required` refuses them while it is missing, `preferred`
 * goes on with the rules alone, `off` never runs it.
 */
export type DeepMode = "required" | "preferred" | "off";

/**
 * What the local model already read, as hashes of the text, so a restart doesn't read every
 * room's history again. Kept beside the vault; `model` names the model the hashes are for.
 */
export const DeepSeenDoc = defineDoc<{ model: string; keys: string[] }>({
  kind: "nudge.deepSeen",
  version: 1,
  scope: "session",
  initial: () => ({ model: "", keys: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
});

/** Most texts remembered as read; the oldest are forgotten first. */
export const MAX_SEEN = 50_000;
/** Words in one piece of text the model reads; longer lines are cut at sentences. */
const MAX_WORDS = 200;

/** Prompt sections that only say what Nudge is and can do, not who anyone is. */
const STATIC_SECTIONS = new Set(["extensions", "time"]);

/**
 * Words the model takes for names that aren't anyone's: pronouns, family words, greetings. Lower
 * case.
 */
const NOT_PERSONAL = new Set(
  (
    "jeg du han hun vi dere de meg deg ham henne oss dem seg man den det " +
    "i me you he she we they him her us them it " +
    "mamma mor mora moren pappa far faren bestemor bestefar farmor farfar mormor morfar " +
    "søster søsteren bror broren sønn sønnen datter datteren kona kone mannen mann " +
    "tante onkel barna barnas barnet ungene sjefen naboen legen tannlegen " +
    "mom mum dad mother father grandma grandpa grandmother grandfather sister brother " +
    "son daughter wife husband aunt uncle kids boss neighbour neighbor doctor " +
    "hei hallo heisann takk hilsen hi hello thanks dear"
  ).split(" "),
);

/** Titles before a name: "Dr. Hansen", "fru Berg". */
const TITLES = /^(?:dr|mr|mrs|ms|miss|prof|fru|frk|herr|sr|jr)\.?$/iu;

export type DeepScannerOptions = {
  readonly detector: DeepDetector;
  readonly mode: Exclude<DeepMode, "off">;
  /** Words never hidden however the model labels them, such as the assistant's own name. */
  readonly allow?: readonly string[];
  /** Hashes read before, as `DeepSeenDoc` keeps them. */
  readonly seen?: { readonly model: string; readonly keys: readonly string[] };
  /** Stores newly read hashes; failures leave them to be read again after a restart. */
  readonly save?: (model: string, keys: readonly string[]) => Promise<void>;
  /** Hears that the model was missing where `preferred` let a request go on without it. */
  readonly report?: (error: unknown) => void;
};

/**
 * Has the local model read text before the model provider sees it, and puts the names, places,
 * addresses and organisations it finds into the vault. Each piece of text is read once.
 */
export class DeepScanner {
  private readonly seen = new Set<string>();
  private unsaved: string[] = [];
  private readonly allow: Set<string>;
  private running: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DeepScannerOptions) {
    if (options.seen?.model === options.detector.id)
      for (const key of options.seen.keys) this.seen.add(key);
    this.allow = new Set(
      [...READABLE_PLACES, ...(options.allow ?? [])].map((word) => vaultKey(word)),
    );
  }

  get mode(): DeepScannerOptions["mode"] {
    return this.options.mode;
  }

  /**
   * Reads what `texts` hold that wasn't read before and protects what it finds, for `owner` alone
   * when given and the value is new. Throws `DeepUnavailable` when the model can't run and the
   * mode is `required`, or `quiet` isn't set.
   */
  async protectIn(
    texts: readonly string[],
    vault: Vault,
    options: { readonly owner?: string; readonly quiet?: boolean } = {},
  ): Promise<void> {
    // One read at a time, so two requests don't read the same history twice.
    const run = this.running.then(() => this.read(texts, vault, options));
    this.running = run.catch(() => {});
    await run;
  }

  private async read(
    texts: readonly string[],
    vault: Vault,
    options: { readonly owner?: string; readonly quiet?: boolean },
  ): Promise<void> {
    const pieces = new Map<string, string>();
    for (const text of texts)
      for (const piece of piecesOf(text)) {
        const key = this.keyOf(piece);
        if (!this.seen.has(key)) pieces.set(key, piece);
      }
    if (pieces.size === 0) return;
    let found;
    try {
      found = await this.options.detector.find([...pieces.values()]);
    } catch (error) {
      if (options.quiet || this.options.mode === "preferred") {
        this.options.report?.(error);
        return;
      }
      throw error instanceof DeepUnavailable
        ? error
        : new DeepUnavailable(`The local name finder failed: ${(error as Error).message}`);
    }
    [...pieces.values()].forEach((piece, i) => {
      for (const finding of found[i] ?? []) {
        for (const value of this.valuesOf(piece.slice(finding.start, finding.end), finding.kind))
          // Only new values: an owner given here must not take a value others already saw.
          vault.protect(value, finding.kind, vault.knows(value) ? undefined : options.owner);
      }
    });
    for (const key of pieces.keys()) this.remember(key);
    await this.save();
  }

  /** What of a finding to protect: none for what isn't personal, each name of a list. */
  private valuesOf(raw: string, kind: string): string[] {
    // "Priya and Daniel" are two people; "Paws & Claws" is one clinic.
    const parts = kind === "ORG" ? [raw] : raw.split(/,\s*|\s+(?:og|and|&)\s+/u);
    return parts.flatMap((part) => {
      const value = this.valueOf(part, kind);
      return value === undefined ? [] : [value];
    });
  }

  private valueOf(raw: string, kind: string): string | undefined {
    // The model's spans run long ("Vethjem for katten", "Søster Helene"): words in lower case
    // and titles at either end go.
    const words = raw.split(/\s+/u).filter((word) => word !== "");
    const extra = (word: string) =>
      /^\p{Ll}/u.test(word) || NOT_PERSONAL.has(word.toLowerCase()) || TITLES.test(word);
    while (words.length > 0 && extra(words.at(-1)!)) words.pop();
    while (words.length > 0 && extra(words[0]!)) words.shift();
    let value = words
      .join(" ")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, "")
      .replace(/['’]s$/u, "");
    if (kind === "ORG") value = withoutOrgType(value);
    if (value.length < 2 || value.includes("⟦") || value.includes("⟧")) return undefined;
    // Names, places and organisations are written with a capital; "borettslaget" and "stranda"
    // are words. Addresses have a number.
    if (!/\p{Lu}|\d/u.test(value)) return undefined;
    const key = vaultKey(value);
    if (NOT_PERSONAL.has(key) || this.allow.has(key)) return undefined;
    return value;
  }

  private keyOf(piece: string): string {
    return createHash("sha256")
      .update(`${this.options.detector.id}\n${piece}`)
      .digest("base64url")
      .slice(0, 22);
  }

  private remember(key: string): void {
    this.seen.add(key);
    this.unsaved.push(key);
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value!;
      this.seen.delete(oldest);
    }
  }

  private async save(): Promise<void> {
    const keys = this.unsaved;
    if (keys.length === 0 || this.options.save === undefined) return;
    this.unsaved = [];
    await this.options.save(this.options.detector.id, keys).catch((error: unknown) => {
      this.options.report?.(error);
    });
  }
}

/**
 * The pieces the model reads of a text: its lines, longer ones cut at sentences and then at
 * `MAX_WORDS`. Lines without a capital letter or a digit can't hold what it looks for and are
 * left out. Unchanged lines give the same pieces, so they are only read once.
 */
export function piecesOf(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split(/\n+/u)) {
    if (!/\p{Lu}|\d/u.test(line.replace(/⟦[A-Z]+\d+⟧/gu, ""))) continue;
    let current: string[] = [];
    const flush = () => {
      if (current.length > 0) pieces.push(current.join(" "));
      current = [];
    };
    for (const sentence of line.trim().split(/(?<=[.!?])\s+/u)) {
      const words = sentence.split(/\s+/u).filter((word) => word !== "");
      if (current.length + words.length > MAX_WORDS) flush();
      for (let i = 0; i < words.length; i += MAX_WORDS) {
        current.push(...words.slice(i, i + MAX_WORDS));
        if (current.length >= MAX_WORDS) flush();
      }
    }
    flush();
  }
  return pieces;
}

/**
 * The text of a request that can carry personal values the model hasn't seen: what people wrote,
 * what tools returned, and prompt sections made from the assistant's data. What the model wrote
 * itself only holds what it was shown, and results of tools in `publicTools` (web search) are the
 * public web; both stay with the rules.
 */
export function textsToScan(context: Context, publicTools: ReadonlySet<string>): string[] {
  const texts: string[] = [];
  const blocks = (content: string | readonly { type: string }[]) => {
    if (typeof content === "string") texts.push(content);
    else
      for (const block of content)
        if (block.type === "text") texts.push((block as unknown as { text: string }).text);
  };
  for (const message of context.messages) {
    switch (message.role) {
      case "system":
        for (const [name, text] of Object.entries(message.sections ?? {}))
          if (text !== null && !STATIC_SECTIONS.has(name)) texts.push(text);
        break;
      case "user":
        blocks(message.content);
        break;
      case "toolResult":
        if (publicTools.has(message.toolName)) break;
        blocks(message.content);
        break;
      case "assistant":
        break;
    }
  }
  return texts;
}
