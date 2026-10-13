// Runs the browser tasks against each model and writes a result line per task.
// pnpm -C extensions/browser eval -- [--model anthropic/claude-haiku-5-5,openai/gpt-5-mini] [--tasks finn-glc,yr-tromso] [--reasoning low]
// Keys come from the environment only (ANTHROPIC_API_KEY, OPENAI_API_KEY, …).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
// Not ../src/index.ts: that pulls in @nudge/core, which plain Node cannot strip.
import { DEFAULT_BROWSER_MODEL, runBrowserAgent } from "../src/agent.ts";
import { BrowserSession } from "../src/browser.ts";
import { tasks } from "./tasks.ts";

const argv = process.argv.slice(2);
const { values } = parseArgs({
  // pnpm passes the `--` separator through to the script
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    model: { type: "string", default: DEFAULT_BROWSER_MODEL },
    tasks: { type: "string" },
    reasoning: { type: "string", default: "low" },
    steps: { type: "string", default: "30" },
    out: { type: "string", default: join(import.meta.dirname, "..", ".eval") },
  },
});

const models = builtinModels();
const runs = values.model!.split(",").map((spec) => {
  const [providerId, ...rest] = spec.trim().split("/");
  const model = models.getModel(providerId!, rest.join("/")) as Model<Api> | undefined;
  if (!model) throw new Error(`Unknown model ${spec}`);
  return { spec: spec.trim(), providerId: providerId!, model };
});

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
    const browser = await BrowserSession.open({
      profileDir: join(values.out!, "profiles", runId, providerId, task.id),
    });
    const started = Date.now();
    const result = await runBrowserAgent({
      models,
      model,
      browser,
      task: task.prompt,
      reasoning: values.reasoning as ThinkingLevel,
      maxSteps: Number(values.steps),
      timeZone: "Europe/Oslo",
      onStep: (step) =>
        log(
          step.type === "note"
            ? `  [${task.id} ${step.step}] ${step.text.slice(0, 200).replace(/\n/g, " ")}`
            : `  [${task.id} ${step.step}] ${step.ok ? "✓" : "✗"} ${step.tool} ${JSON.stringify(step.args)} → ${step.result.slice(0, 140)}`,
        ),
    }).catch((error: unknown) => ({
      outcome: `crash: ${String(error).split("\n")[0]}`,
      answer: "",
      steps: 0,
      actions: 0,
      actionErrors: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } },
    }));
    const finalUrl = browser.page.url();
    await browser.close();
    const outcome = "error" in result && result.error ? `error: ${result.error}` : result.outcome;
    const record = {
      run: runId,
      task: task.id,
      model: spec,
      reasoning: values.reasoning,
      outcome,
      expectMatched: task.expect ? task.expect.test(result.answer) : undefined,
      steps: result.steps,
      actions: result.actions,
      actionErrors: result.actionErrors,
      seconds: Math.round((Date.now() - started) / 1000),
      tokens: {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cost: result.usage.cost.total,
      },
      finalUrl,
      answer: result.answer,
    };
    appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
    log(
      `${task.id}: ${outcome}, ${result.steps} steps, ${result.actions} actions (${result.actionErrors} failed), ${record.seconds}s, ${result.usage.input + result.usage.cacheRead} in / ${result.usage.output} out tokens, $${result.usage.cost.total.toFixed(3)}\n${result.answer}\n`,
    );
  }
}
