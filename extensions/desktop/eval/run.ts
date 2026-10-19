// Runs the desktop tasks against each model, a few times each, through the same redaction as
// Nudge, each run on a desktop and home of its own, and writes a result line per run, every
// request the providers got, and a summary table.
// pnpm -C extensions/desktop eval -- [--model anthropic/claude-haiku-5-5] [--tasks calc-sum] [--runs 2] [--apps apps.json]
// Keys come from the environment only (ANTHROPIC_API_KEY, …). Needs `pnpm build` first: plain
// Node runs @nudge/core from its build. The apps are started as `--apps` says (see DEFAULT_APPS);
// `{home}` in their arguments is the run's home.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
// The browser eval's report: the leak check and the table are the same for both.
import { findLeaks, type RunRecord, summaryTable } from "../../browser/eval/report.ts";
// Not ../src/index.ts: that pulls in @nudge/core's source, which plain Node cannot strip.
import { DEFAULT_DESKTOP_MODEL, runDesktopAgent } from "../src/agent.ts";
import { DesktopSession } from "../src/session.ts";
import { setUp, tasks } from "./tasks.ts";

/**
 * How the apps start unless `--apps` says otherwise. LibreOffice runs on its Qt backend: on
 * GTK 3 it aborts when its windows are read (IllegalAccessibleComponentStateException).
 */
const DEFAULT_APPS: Record<string, string[]> = {
  editor: ["gnome-text-editor"],
  writer: ["env", "SAL_USE_VCLPLUGIN=qt6", "libreoffice", "--writer", "--norestore", "--nologo"],
  calc: ["env", "SAL_USE_VCLPLUGIN=qt6", "libreoffice", "--calc", "--norestore", "--nologo"],
  files: ["dolphin"],
  web: [
    "firefox",
    "--no-remote",
    "--new-instance",
    "--profile",
    "{home}/.firefox",
    "file://{home}/Documents/ordre.html",
  ],
};

/** Firefox without its first-run pages and prompts. */
const FIREFOX_PREFS = [
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);',
].join("\n");

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const argv = process.argv.slice(2);
const { values } = parseArgs({
  // pnpm passes the `--` separator through to the script
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    model: { type: "string", default: DEFAULT_DESKTOP_MODEL },
    tasks: { type: "string" },
    runs: { type: "string", default: "2" },
    reasoning: { type: "string", default: "low" },
    steps: { type: "string", default: "40" },
    apps: { type: "string" },
    out: { type: "string", default: join(import.meta.dirname, "..", ".eval") },
  },
});
const repeat = Number(values.runs);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) fail("--runs takes 1 to 5.");
const apps: Record<string, string[]> = {
  ...DEFAULT_APPS,
  ...(values.apps
    ? (JSON.parse(readFileSync(values.apps, "utf8")) as Record<string, string[]>)
    : {}),
};

const core = await import("@nudge/core").catch((error: unknown) =>
  fail(`Could not load @nudge/core (run \`pnpm build\` first): ${String(error).split("\n")[0]}`),
);

const providers = builtinModels();
const runs = [];
for (const spec of values.model!.split(",").map((s) => s.trim())) {
  const [providerId, ...rest] = spec.split("/");
  const model = providers.getModel(providerId!, rest.join("/")) as Model<Api> | undefined;
  if (!model) fail(`Unknown model ${spec}.`);
  // Fail before any desktop opens: a run without a key only reports errors.
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
      // A fresh home per run, so files and app settings don't carry over between runs.
      const home = join(values.out!, "homes", runId, providerId, task.id, String(n));
      setUp(task, home);
      mkdirSync(join(home, ".firefox"), { recursive: true });
      writeFileSync(join(home, ".firefox", "user.js"), FIREFOX_PREFS);
      const taskApps = Object.fromEntries(
        task.apps.map((name) => {
          const command = apps[name] ?? fail(`No app called ${name}; add it to --apps.`);
          return [name, command.map((arg) => arg.replaceAll("{home}", home))];
        }),
      );
      const desktop = await DesktopSession.open({ apps: taskApps, homeDir: home });
      const label = `${task.id}#${n}`;
      const started = Date.now();
      const result = await runDesktopAgent({
        models,
        model,
        desktop,
        task: task.prompt,
        apps: task.apps,
        reasoning: values.reasoning as ThinkingLevel,
        maxSteps: Number(values.steps),
        timeZone: "Europe/Oslo",
        onStep: (step) => {
          if (step.type === "doing") return;
          log(
            step.type === "note"
              ? `  [${label} ${step.step}] ${step.text.slice(0, 200).replace(/\n/g, " ")}`
              : `  [${label} ${step.step}] ${step.ok ? "✓" : "✗"} ${step.tool} ${JSON.stringify(step.args)} → ${step.result.slice(0, 140).replace(/\n/g, " ")}`,
          );
        },
      }).catch((error: unknown) => ({
        outcome: `crash: ${String(error).split("\n")[0]}`,
        answer: "",
        error: undefined,
        steps: 0,
        actions: 0,
        actionErrors: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } },
      }));
      await desktop.close();
      for (const request of sent)
        appendFileSync(
          requestsFile,
          `${JSON.stringify({ task: task.id, model: spec, run: n, request })}\n`,
        );
      const leaks = findLeaks(sent, task.personal ?? []);
      const outcome = result.error ? `error: ${result.error}` : result.outcome;
      // The answer, the files and the outcome all have to be right.
      const problems = [
        task.expect && !task.expect.test(result.answer) ? "answer does not match" : undefined,
        task.check?.(home),
        (task.outcome ?? "answered") !== outcome ? `ended ${outcome}` : undefined,
      ].filter(Boolean);
      const seconds = Math.round((Date.now() - started) / 1000);
      const record = {
        run: runId,
        n,
        task: task.id,
        model: spec,
        reasoning: values.reasoning,
        outcome,
        expectMatched: problems.length === 0,
        problems,
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
        home,
        answer: result.answer,
      };
      appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
      records.push({
        task: task.id,
        model: spec,
        outcome,
        expectMatched: record.expectMatched,
        steps: result.steps,
        seconds,
        cost: result.usage.cost.total,
        leaks: leaks.length,
      });
      log(
        `${label}: ${outcome}${problems.length ? ` (${problems.join("; ")})` : ", as expected"}, ${result.steps} steps, ${result.actions} actions (${result.actionErrors} failed), ${seconds}s, ${result.usage.input + result.usage.cacheRead} in / ${result.usage.output} out tokens, $${result.usage.cost.total.toFixed(3)}${leaks.length ? `, LEAKED ${[...new Set(record.leaks)].join(", ")}` : ""}\n${result.answer}\n`,
      );
    }
  }
}

const table = summaryTable(records);
writeFileSync(summaryFile, `# Desktop eval ${runId}\n\n${table}\n`);
log(`\n${table}\n\nRequests: ${requestsFile}\nSummary: ${summaryFile}`);
if (records.some((record) => record.leaks > 0)) {
  console.error("Personal values from a task reached a provider; see the leaks column.");
  process.exitCode = 1;
}
