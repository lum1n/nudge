// Runs the browser tasks against each model, a few times each, through the same redaction as
// Nudge, and writes a result line per run, every request the providers got, and a summary table.
// pnpm -C extensions/browser eval -- [--model anthropic/claude-haiku-5-5,openai/gpt-5-mini] [--tasks finn-glc,yr-tromso] [--runs 2] [--reasoning low]
// Keys come from the environment only (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). Needs `pnpm build`
// first: plain Node runs @nudge/core from its build.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
// Not ../src/index.ts: that pulls in @nudge/core's source, which plain Node cannot strip.
import { DEFAULT_BROWSER_MODEL, runBrowserAgent } from "../src/agent.ts";
import { BrowserSession } from "../src/browser.ts";
import { findLeaks, type RunRecord, summaryTable } from "./report.ts";
import { tasks } from "./tasks.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const argv = process.argv.slice(2);
const { values } = parseArgs({
  // pnpm passes the `--` separator through to the script
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    model: { type: "string", default: DEFAULT_BROWSER_MODEL },
    tasks: { type: "string" },
    runs: { type: "string", default: "2" },
    reasoning: { type: "string", default: "low" },
    steps: { type: "string", default: "30" },
    out: { type: "string", default: join(import.meta.dirname, "..", ".eval") },
  },
});
const repeat = Number(values.runs);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) fail("--runs takes 1 to 5.");

const core = await import("@nudge/core").catch((error: unknown) =>
  fail(`Could not load @nudge/core (run \`pnpm build\` first): ${String(error).split("\n")[0]}`),
);

const providers = builtinModels();
const runs = [];
for (const spec of values.model!.split(",").map((s) => s.trim())) {
  const [providerId, ...rest] = spec.split("/");
  const model = providers.getModel(providerId!, rest.join("/")) as Model<Api> | undefined;
  if (!model) fail(`Unknown model ${spec}.`);
  // Fail before any browser opens: a run without a key only reports errors.
  const auth = await providers.checkAuth(providerId!).catch(() => undefined);
  if (auth === undefined)
    fail(
      `No credentials for ${providerId} (for ${spec}). Set its API key in the environment, such as ${providerId!.toUpperCase().replace(/-/g, "_")}_API_KEY.`,
    );
  runs.push({ spec, providerId: providerId!, model: model! });
}
const selected = values.tasks
  ? tasks.filter((t) => values.tasks!.split(",").includes(t.id))
  : tasks;
if (selected.length === 0) fail(`No tasks match ${values.tasks}.`);

mkdirSync(values.out!, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
// A fresh browser profile per run, so remembered searches and consents don't carry over between runs.
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const resultsFile = join(values.out!, `results-${stamp}.jsonl`);
const requestsFile = join(values.out!, `requests-${runId}.jsonl`);
const summaryFile = join(values.out!, `summary-${runId}.md`);
const logFile = join(values.out!, `run-${stamp}.log`);
const log = (line: string) => {
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
};

const records: RunRecord[] = [];
for (const { spec, providerId, model } of runs) {
  for (const task of selected) {
    for (let n = 1; n <= repeat; n++) {
      // Every request as the provider gets it, after redaction, as Nudge would send it.
      const sent: string[] = [];
      const models = new core.RedactingModels(providers, {
        detectors: core.builtinDetectors,
        onRequest: ({ context }) => sent.push(JSON.stringify(context)),
      });
      models.bind(new core.Vault(), async () => {});
      for (const name of task.names ?? []) models.vault.protect(name, "NAME");
      const browser = await BrowserSession.open({
        profileDir: join(values.out!, "profiles", runId, providerId, task.id, String(n)),
      });
      const label = `${task.id}#${n}`;
      const started = Date.now();
      const result = await runBrowserAgent({
        models,
        model,
        browser,
        task: task.prompt,
        reasoning: values.reasoning as ThinkingLevel,
        maxSteps: Number(values.steps),
        timeZone: "Europe/Oslo",
        onStep: (step) => {
          if (step.type === "doing") return;
          log(
            step.type === "note"
              ? `  [${label} ${step.step}] ${step.text.slice(0, 200).replace(/\n/g, " ")}`
              : `  [${label} ${step.step}] ${step.ok ? "✓" : "✗"} ${step.tool} ${JSON.stringify(step.args)} → ${step.result.slice(0, 140)}`,
          );
        },
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
      for (const request of sent)
        appendFileSync(
          requestsFile,
          `${JSON.stringify({ task: task.id, model: spec, run: n, request })}\n`,
        );
      const leaks = findLeaks(sent, task.personal ?? []);
      const outcome = "error" in result && result.error ? `error: ${result.error}` : result.outcome;
      const seconds = Math.round((Date.now() - started) / 1000);
      const record = {
        run: runId,
        n,
        task: task.id,
        model: spec,
        reasoning: values.reasoning,
        outcome,
        expectMatched: task.expect ? task.expect.test(result.answer) : undefined,
        steps: result.steps,
        actions: result.actions,
        actionErrors: result.actionErrors,
        seconds,
        requests: sent.length,
        leaks: leaks.map((leak) => leak.value),
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
      records.push({
        task: task.id,
        model: spec,
        outcome,
        ...(record.expectMatched === undefined ? {} : { expectMatched: record.expectMatched }),
        steps: result.steps,
        seconds,
        cost: result.usage.cost.total,
        leaks: leaks.length,
      });
      log(
        `${label}: ${outcome}, ${result.steps} steps, ${result.actions} actions (${result.actionErrors} failed), ${seconds}s, ${result.usage.input + result.usage.cacheRead} in / ${result.usage.output} out tokens, $${result.usage.cost.total.toFixed(3)}${leaks.length ? `, LEAKED ${[...new Set(record.leaks)].join(", ")}` : ""}\n${result.answer}\n`,
      );
    }
  }
}

const table = summaryTable(records);
writeFileSync(summaryFile, `# Browser eval ${runId}\n\n${table}\n`);
log(`\n${table}\n\nRequests: ${requestsFile}\nSummary: ${summaryFile}`);
if (records.some((record) => record.leaks > 0)) {
  console.error("Personal values from a task reached a provider; see the leaks column.");
  process.exitCode = 1;
}
