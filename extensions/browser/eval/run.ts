// Runs the browser tasks against each model and writes a result line per task.
// pnpm -C extensions/browser eval -- [--model anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5] [--tasks finn-glc,yr-tromso] [--reasoning low]
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Api,
  ThinkingLevel,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { BrowserSession, browserTools, runBatch } from "../src/index.ts";
import { tasks } from "./tasks.ts";

const argv = process.argv.slice(2);
const { values } = parseArgs({
  // pnpm passes the `--` separator through to the script
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    model: { type: "string", default: "anthropic/claude-haiku-5-5" },
    tasks: { type: "string" },
    reasoning: { type: "string", default: "low" },
    steps: { type: "string", default: "30" },
    out: { type: "string", default: join(import.meta.dirname, "..", ".eval") },
  },
});

const models = createModels();
for (const provider of [
  anthropicProvider(),
  openaiProvider(),
  xaiProvider(),
  openrouterProvider(),
  googleProvider(),
]) {
  models.setProvider(provider);
}
const runs = values.model!.split(",").map((spec) => {
  const [providerId, ...rest] = spec.trim().split("/");
  const model = models.getModel(providerId!, rest.join("/")) as Model<Api> | undefined;
  if (!model) throw new Error(`Unknown model ${spec}`);
  return { spec: spec.trim(), providerId: providerId!, model };
});

const today = new Date().toLocaleDateString("en-GB", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Europe/Oslo",
});
const systemPrompt = `You operate a web browser for the user. Today is ${today}; the user is in Norway.

You see pages as text: open dialogs first, then the page with controls marked by refs like [e12]. Lists of results are shown as one "item:" line each. Act with the browser tools, using refs from the latest observation.

- Handle anything under OPEN DIALOGS before the page. For cookie banners, reject optional cookies if that is easy, otherwise accept.
- Prefer the fastest route: the site's own search box and filters, or a URL with parameters you have actually seen on that site in this session. Never guess URL parameters.
- After searching or filtering, check that the filters took effect (the URL, the hit count, and that the results really have the requested properties). If results look unfiltered, empty or odd, go back to the site's own search box and filters.
- You may send several tool calls in one turn; they run in order and stop at the first failure. After your last call you see the page again.
- If the page is long, use browser_find or read the next page instead of scrolling repeatedly.
- Check that the results really match every part of the request before answering. If something cannot be found, say so.
- Do not log in, buy, send messages or submit personal data.
- State only what you saw on the pages in this session, not what you believe from elsewhere.
- Your last message goes to the user as is: answer briefly, with links, and without notes about your process.`;

const tools = browserTools.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

/** Older page snapshots are dropped from the request; their first line (what happened) stays. */
function forRequest(messages: Message[]): Message[] {
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  return messages.map((m, i) => {
    if (m.role !== "toolResult" || i > lastAssistant) return m;
    const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const head = text.split("\n")[0] ?? "";
    return text.length > head.length + 200
      ? { ...m, content: [{ type: "text", text: `${head}\n(older page view omitted)` }] }
      : m;
  });
}

mkdirSync(values.out!, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
// A fresh browser profile per run, so remembered searches and consents don't carry over between runs.
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const resultsFile = join(values.out!, `results-${stamp}.jsonl`);
const logFile = join(values.out!, `run-${stamp}.log`);
const log = (line: string) => {
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
};
const selected = values.tasks
  ? tasks.filter((t) => values.tasks!.split(",").includes(t.id))
  : tasks;

for (const { spec, providerId, model } of runs) {
  for (const task of selected) {
    const session = await BrowserSession.open({
      profileDir: join(values.out!, "profiles", runId, providerId, task.id),
    });
    const started = Date.now();
    const messages: Message[] = [{ role: "user", content: task.prompt, timestamp: Date.now() }];
    const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
    let steps = 0;
    let actions = 0;
    let errors = 0;
    let answer = "";
    let outcome = "max-steps";
    try {
      for (; steps < Number(values.steps); steps++) {
        const context: Context = { systemPrompt, messages: forRequest(messages), tools };
        const message: AssistantMessage = await models
          .streamSimple(model, context, {
            reasoning: values.reasoning as ThinkingLevel,
            maxTokens: 8_000,
          })
          .result();
        messages.push(message);
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cost += message.usage.cost.total;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          outcome = `error: ${message.errorMessage ?? message.stopReason}`;
          break;
        }
        const calls = message.content.filter((c) => c.type === "toolCall");
        const text = message.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("")
          .trim();
        if (text) log(`  [${task.id} ${steps + 1}] ${text.slice(0, 200).replace(/\n/g, " ")}`);
        if (!calls.length) {
          answer = text;
          outcome = "answered";
          steps++;
          break;
        }
        const outputs = await runBatch(
          session,
          calls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: c.arguments as Record<string, unknown>,
          })),
        );
        for (const o of outputs) {
          actions++;
          if (o.isError) errors++;
          const call = calls.find((c) => c.id === o.id)!;
          log(
            `  [${task.id} ${steps + 1}] ${o.isError ? "✗" : "✓"} ${o.name} ${JSON.stringify(call.arguments)} → ${o.text.split("\n")[0]!.slice(0, 140)}`,
          );
          const result: ToolResultMessage = {
            role: "toolResult",
            toolCallId: o.id,
            toolName: o.name,
            content: [{ type: "text", text: o.text }],
            isError: o.isError,
            timestamp: Date.now(),
          };
          messages.push(result);
        }
      }
    } catch (error) {
      outcome = `crash: ${String(error).split("\n")[0]}`;
    }
    const finalUrl = session.page.url();
    await session.close();
    const record = {
      run: runId,
      task: task.id,
      model: spec,
      reasoning: values.reasoning,
      outcome,
      expectMatched: task.expect ? task.expect.test(answer) : undefined,
      steps,
      actions,
      actionErrors: errors,
      seconds: Math.round((Date.now() - started) / 1000),
      tokens: usage,
      finalUrl,
      answer,
    };
    appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
    log(
      `${task.id}: ${outcome}, ${steps} steps, ${actions} actions (${errors} failed), ${record.seconds}s, ${usage.input + usage.cacheRead} in / ${usage.output} out tokens, $${usage.cost.toFixed(3)}\n${answer}\n`,
    );
  }
}
