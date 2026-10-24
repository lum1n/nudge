// Redaction cost: a vault of 1k and 10k values and a long conversation, redacted the way each
// request is (`redactContext`). pnpm -C packages/core bench:redaction -- [--sizes 1000,10000]
//   [--messages 200] [--runs 5]
// Reports, per vault size: building the matcher after a change, a request with the vault as it
// was (as each tool round of a turn sends), a request after one new value, and `showTo`.
import type { Context, Message } from "@earendil-works/pi-ai";
import { parseArgs } from "node:util";
import { builtinDetectors } from "../src/privacy/detectors.ts";
import { redactContext } from "../src/privacy/redact.ts";
import { Vault } from "../src/privacy/vault.ts";

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    sizes: { type: "string", default: "1000,10000" },
    messages: { type: "string", default: "200" },
    runs: { type: "string", default: "5" },
  },
});
const sizes = values.sizes.split(",").map(Number);
const messageCount = Number(values.messages);
const runs = Number(values.runs);

const FIRST = ["Ann", "Kari", "Ola", "Per", "Ingrid", "Lars", "Nora", "Emil", "Sofie", "Jonas"];
const LAST = ["Berg", "Hansen", "Olsen", "Dahl", "Lie", "Moen", "Haugen", "Strand", "Bakke"];

/** Deterministic pseudo-random numbers, so every run redacts the same text. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

/** `size` values the way a vault grows: names (some owned), places, emails and phone numbers. */
function filledVault(size: number): { vault: Vault; values: string[] } {
  const vault = new Vault();
  const values: string[] = [];
  for (let i = 0; i < size; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = `${LAST[i % LAST.length]}${i}`;
    const [value, kind] = (
      [
        [`${first} ${last}`, "NAME"],
        [`Gate${i} ${i % 90}`, "PLACE"],
        [`${first.toLowerCase()}.${last.toLowerCase()}@example.com`, "EMAIL"],
        [`+47 9${String(i).padStart(7, "0")}`, "PHONE"],
      ] as const
    )[i % 4]!;
    vault.protect(value, kind, i % 10 === 0 ? `@user${i % 3}:example.org` : undefined);
    values.push(value);
  }
  return { vault, values };
}

const FILLER =
  "Remember to pick up the parcel before the shop closes, and send a note about Thursday. " +
  "The meeting moved to half past two; bring the printed agenda and the budget figures. ";

/** A conversation of user, assistant and tool-result messages, each naming a few vault values. */
function conversation(values: readonly string[], count: number): Context {
  const next = random(42);
  const pick = () => values[Math.floor(next() * values.length)]!;
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    const text = `${FILLER}Ask ${pick()} and ${pick()}s friend about it. ${FILLER}Mail ${pick()}.`;
    if (i % 3 === 0) messages.push({ role: "user", content: text, timestamp: 0 });
    else if (i % 3 === 1)
      messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "bench",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      });
    else
      messages.push({
        role: "toolResult",
        toolCallId: `call${i}`,
        toolName: "search",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 0,
      });
  }
  return { systemPrompt: `You are a helpful assistant. ${FILLER}`, messages };
}

/** Median milliseconds of `runs` calls of `run`, each after `setup`. */
function time(run: () => void, setup: () => void = () => {}): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    setup();
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

const contextChars = (context: Context) => JSON.stringify(context.messages).length;
let added = 0;
const rows: Record<string, string | number>[] = [];
for (const size of sizes) {
  const { vault, values } = filledVault(size);
  const context = conversation(values, messageCount);
  // Fill in the spellings and detected values once, as earlier requests would have.
  redactContext(context, vault, builtinDetectors);
  const addOne = () => {
    vault.protect(`Newcomer Person${added++}`, "NAME");
  };
  rows.push({
    entries: vault.entries.length,
    "history chars": contextChars(context),
    "matcher build ms": time(() => vault.redact("Ann", builtinDetectors), addOne).toFixed(2),
    "request, same vault ms": time(() => redactContext(context, vault, builtinDetectors)).toFixed(
      2,
    ),
    "request, one new value ms": time(
      () => redactContext(context, vault, builtinDetectors),
      addOne,
    ).toFixed(2),
    "showTo history ms": time(() => {
      for (const message of context.messages)
        if (message.role === "user" && typeof message.content === "string")
          vault.showTo(undefined, message.content);
    }).toFixed(2),
  });
}
console.table(rows);
