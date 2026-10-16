import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  ThinkingLevel,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { browserTools, type Browser, progressLine, runBatch } from "./tools.ts";

/** What the browser agent runs on unless configured otherwise. */
export const DEFAULT_BROWSER_MODEL = "anthropic/claude-haiku-5-5";

export interface BrowserAgentOptions {
  /** Every request goes through these; in Nudge they redact personal data. */
  models: Models;
  model: Model<Api>;
  browser: Browser;
  task: string;
  reasoning?: ThinkingLevel;
  maxSteps?: number;
  timeZone?: string;
  now?: () => number;
  signal?: AbortSignal;
  onStep?: (step: BrowserStep) => void;
  /**
   * An action the user approved after an earlier run stopped for it (`needs-confirmation`); this
   * run may do exactly that, once.
   */
  approved?: string;
  /**
   * Notes kept per site from earlier runs: shown the first time a run reaches the site, and asked
   * for again after a run that answered with at least `minActions` actions.
   */
  siteNotes?: SiteNotes;
}

export interface SiteNotes {
  read(host: string): string | undefined;
  /** New notes by host; a host left out keeps what it had. */
  write(notes: Readonly<Record<string, string>>): void | Promise<void>;
  /** Runs shorter than this teach little; default 3. */
  minActions?: number;
}

/** Characters of notes kept per site. */
export const MAX_SITE_NOTES = 1_200;

/** The host a page observation is on, without `www.`, from its `URL:` line. */
export function observedHost(text: string): string | undefined {
  const url = /^URL: (\S+)/m.exec(text)?.[1];
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** The request for notes at the end of a run. */
export function notesRequest(hosts: readonly string[]): string {
  return [
    `Before you finish: write notes for your next visit to ${hosts.join(", ")}.`,
    "Only how to use each site: where search and filters are, URL parameters you saw work, " +
      "which button closes the cookie dialog, traps to avoid. Nothing about the user, this task " +
      "or what you found. At most 6 short lines per site; keep what still holds from the notes " +
      "you were shown.",
    'Reply with only a JSON object from site to notes, like {"example.no": "…"}; leave out sites with nothing worth keeping.',
  ].join("\n");
}

export type BrowserStep =
  | { type: "note"; step: number; text: string }
  /** Before an action runs: what it is about to do, for people watching (`progressLine`). */
  | { type: "doing"; step: number; tool: string; text: string }
  | { type: "action"; step: number; tool: string; args: unknown; ok: boolean; result: string };

export interface BrowserAgentResult {
  outcome: "answered" | "needs-login" | "needs-confirmation" | "max-steps" | "error" | "aborted";
  answer: string;
  /** With `needs-confirmation`: the action the user is asked to approve. */
  action?: string;
  error?: string;
  steps: number;
  actions: number;
  actionErrors: number;
  usage: Usage;
}

export function browserSystemPrompt(now: Date, timeZone: string): string {
  const today = now.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  });
  return `You operate a web browser for the user. Today is ${today} (time zone ${timeZone}).

You see pages as text: open dialogs first, then the page with controls marked by refs like [e12]. Lists of results are shown as one "item:" line each. Act with the browser tools, using refs from the latest observation.

- Handle anything under OPEN DIALOGS before the page. For cookie banners, reject optional cookies if that is easy, otherwise accept.
- Prefer the fastest route: the site's own search box and filters, or a URL with parameters you have actually seen on that site in this session. Never guess URL parameters.
- After searching or filtering, check that the filters took effect (the URL, the hit count, and that the results really have the requested properties). If results look unfiltered, empty or odd, go back to the site's own search box and filters.
- You may send several tool calls in one turn; they run in order and stop at the first failure. After your last call you see the page again.
- If the page is long, use browser_find or read the next page instead of scrolling repeatedly.
- Check that the results really match every part of the request before answering. If something cannot be found, say so.
- Never buy, book, send messages or forms, sign up, post, or enter the user's personal data on your own. When the task needs one of these, get to the point just before it and call browser_confirm with the exact action; the user decides. To log in, use browser_login (the user's saved login for the site; you never see it). If there is none, or the site asks for a code or BankID, call browser_request_login.
- State only what you saw on the pages in this session, not what you believe from elsewhere.
- Your last message is the answer to the task: brief, with links, and without notes about your process.`;
}

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

/** Runs one browsing task to an answer: the model acts through the browser tools until it replies without one. */
export async function runBrowserAgent(options: BrowserAgentOptions): Promise<BrowserAgentResult> {
  const now = options.now ?? Date.now;
  const systemPrompt = browserSystemPrompt(
    new Date(now()),
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const task =
    options.approved === undefined
      ? options.task
      : `${options.task}\n\nYou stopped earlier to ask the user to approve this action, and they approved it: ${options.approved}\nThe browser is where you left it. Do exactly that action, once, then finish the task. Anything else that needs approval still needs browser_confirm.`;
  const messages: Message[] = [{ role: "user", content: task, timestamp: now() }];
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const result: BrowserAgentResult = {
    outcome: "max-steps",
    answer: "",
    steps: 0,
    actions: 0,
    actionErrors: 0,
    usage,
  };
  const maxSteps = options.maxSteps ?? 30;
  const visited = new Set<string>();
  while (result.steps < maxSteps) {
    if (options.signal?.aborted) {
      result.outcome = "aborted";
      break;
    }
    const context: Context = { systemPrompt, messages: forRequest(messages), tools };
    const message: AssistantMessage = await options.models
      .streamSimple(options.model, context, {
        reasoning: options.reasoning ?? "low",
        maxTokens: 8_000,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      .result();
    result.steps++;
    messages.push(message);
    addUsage(usage, message.usage);
    if (message.stopReason === "aborted") {
      result.outcome = "aborted";
      break;
    }
    if (message.stopReason === "error") {
      result.outcome = "error";
      result.error = message.errorMessage ?? "the model request failed";
      break;
    }
    const text = message.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    const calls = message.content.filter((c) => c.type === "toolCall");
    if (text) options.onStep?.({ type: "note", step: result.steps, text });
    if (!calls.length) {
      result.answer = text;
      result.outcome = "answered";
      break;
    }
    const outputs = await runBatch(
      options.browser,
      calls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments as Record<string, unknown>,
      })),
      (call) =>
        options.onStep?.({
          type: "doing",
          step: result.steps,
          tool: call.name,
          text: progressLine(options.browser, call),
        }),
    );
    for (const output of outputs) {
      const host = observedHost(output.text);
      if (host !== undefined && !visited.has(host)) {
        visited.add(host);
        const notes = options.siteNotes?.read(host);
        if (notes) output.text += `\n\nYour notes from earlier visits to ${host}:\n${notes}`;
      }
      result.actions++;
      if (output.isError) result.actionErrors++;
      const call = calls.find((c) => c.id === output.id)!;
      options.onStep?.({
        type: "action",
        step: result.steps,
        tool: output.name,
        args: call.arguments,
        ok: !output.isError,
        result: output.text.split("\n")[0] ?? "",
      });
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: output.id,
        toolName: output.name,
        content: [{ type: "text", text: output.text }],
        isError: output.isError,
        timestamp: now(),
      };
      messages.push(toolResult);
    }
    const ended = outputs.find((output) => output.ends);
    if (ended?.ends) {
      result.outcome = ended.ends;
      result.answer = ended.text;
      if (ended.ends === "needs-confirmation") result.action = String(ended.args?.action ?? "");
      break;
    }
  }
  const notes = options.siteNotes;
  if (
    notes !== undefined &&
    result.outcome === "answered" &&
    result.actions >= (notes.minActions ?? 3) &&
    visited.size > 0 &&
    !options.signal?.aborted
  ) {
    try {
      const request: Context = {
        systemPrompt,
        messages: [
          ...forRequest(messages),
          { role: "user", content: notesRequest([...visited]), timestamp: now() },
        ],
        tools,
      };
      const reply = await options.models
        .streamSimple(options.model, request, {
          reasoning: "minimal",
          maxTokens: 1_500,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        .result();
      addUsage(usage, reply.usage);
      const text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      const parsed = json === undefined ? {} : (JSON.parse(json) as Record<string, unknown>);
      const kept = Object.fromEntries(
        Object.entries(parsed)
          .map(([host, value]) => [host.replace(/^www\./, ""), value] as const)
          .filter(
            (entry): entry is readonly [string, string] =>
              visited.has(entry[0]) && typeof entry[1] === "string" && entry[1].trim() !== "",
          )
          .map(([host, value]) => [host, value.trim().slice(0, MAX_SITE_NOTES)]),
      );
      if (Object.keys(kept).length > 0) await notes.write(kept);
    } catch {
      // Notes are a help, not the task: a run that answered stays answered.
    }
  }
  return result;
}

function addUsage(total: Usage, add: Usage): void {
  total.input += add.input;
  total.output += add.output;
  total.cacheRead += add.cacheRead;
  total.cacheWrite += add.cacheWrite;
  total.totalTokens += add.totalTokens;
  total.cost.input += add.cost.input;
  total.cost.output += add.cost.output;
  total.cost.cacheRead += add.cost.cacheRead;
  total.cost.cacheWrite += add.cost.cacheWrite;
  total.cost.total += add.cost.total;
}
