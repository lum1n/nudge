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
import { type Desktop, desktopTools, progressLine, runBatch } from "./tools.ts";

/** What the desktop agent runs on unless configured otherwise. */
export const DEFAULT_DESKTOP_MODEL = "anthropic/claude-haiku-5-5";

export interface DesktopAgentOptions {
  /** Every request goes through these; in Nudge they redact personal data. */
  models: Models;
  model: Model<Api>;
  desktop: Desktop;
  task: string;
  /** The names of the apps it may start. */
  apps: readonly string[];
  reasoning?: ThinkingLevel;
  maxSteps?: number;
  timeZone?: string;
  now?: () => number;
  signal?: AbortSignal;
  onStep?: (step: DesktopStep) => void;
  /**
   * An action the user approved after an earlier run stopped for it (`needs-confirmation`); this
   * run may do exactly that, once.
   */
  approved?: string;
}

export type DesktopStep =
  | { type: "note"; step: number; text: string }
  /** Before an action runs: what it is about to do, for people watching (`progressLine`). */
  | { type: "doing"; step: number; tool: string; text: string }
  | { type: "action"; step: number; tool: string; args: unknown; ok: boolean; result: string };

export interface DesktopAgentResult {
  outcome: "answered" | "needs-confirmation" | "max-steps" | "error" | "aborted";
  answer: string;
  /** With `needs-confirmation`: the action the user is asked to approve. */
  action?: string;
  error?: string;
  steps: number;
  actions: number;
  actionErrors: number;
  usage: Usage;
}

export function desktopSystemPrompt(now: Date, timeZone: string, apps: readonly string[]): string {
  const today = now.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  });
  return `You operate desktop apps on a Linux desktop for the user. Today is ${today} (time zone ${timeZone}).

You see the open windows as text read from their accessibility tree: open menus and dialogs first, then each window, with controls marked by refs like [e12]. Act with the desktop tools, using refs from the latest observation.

- The apps you can start with desktop_launch: ${apps.length ? apps.join(", ") : "none"}. If the task needs an app that is not open, start it.
- Handle anything under OPEN DIALOGS first: the window behind a dialog takes no clicks until it closes. While a menu is open it takes the keys and clicks; pick an item or press Escape.
- Windows have no window manager: they open on top of each other. Use desktop_focus_window to bring one to the front before pressing keys into it.
- Prefer the app's own controls; keyboard shortcuts (like ctrl+s) are fine when you know them.
- You may send several tool calls in one turn; they run in order and stop at the first failure. After your last call you see the windows again.
- If a window is long, use desktop_find or read the next page instead of guessing.
- Never send, delete, pay, publish, or save over an existing file on your own. When the task needs one of these, get to the point just before it and call desktop_confirm with the exact action; the user decides. The desktop refuses such steps until then.
- State only what you saw in the windows in this session.
- Your last message is the answer to the task: brief, and without notes about your process.`;
}

const tools = desktopTools.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

/** Older views of the windows are dropped from the request; their first line (what happened) stays. */
function forRequest(messages: Message[]): Message[] {
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  return messages.map((m, i) => {
    if (m.role !== "toolResult" || i > lastAssistant) return m;
    const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const head = text.split("\n")[0] ?? "";
    return text.length > head.length + 200
      ? { ...m, content: [{ type: "text", text: `${head}\n(older view omitted)` }] }
      : m;
  });
}

/** Runs one desktop task to an answer: the model acts through the desktop tools until it replies without one. */
export async function runDesktopAgent(options: DesktopAgentOptions): Promise<DesktopAgentResult> {
  const now = options.now ?? Date.now;
  const systemPrompt = desktopSystemPrompt(
    new Date(now()),
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    options.apps,
  );
  const task =
    options.approved === undefined
      ? options.task
      : `${options.task}\n\nYou stopped earlier to ask the user to approve this action, and they approved it: ${options.approved}\nThe desktop is where you left it. Do exactly that action, once, then finish the task. Anything else that needs approval still needs desktop_confirm.`;
  const messages: Message[] = [{ role: "user", content: task, timestamp: now() }];
  // Lets the approved action through the harness's own checks, once.
  const approval = { granted: options.approved !== undefined };
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const result: DesktopAgentResult = {
    outcome: "max-steps",
    answer: "",
    steps: 0,
    actions: 0,
    actionErrors: 0,
    usage,
  };
  const maxSteps = options.maxSteps ?? 30;
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
      options.desktop,
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
          text: progressLine(options.desktop, call),
        }),
      approval,
    );
    for (const output of outputs) {
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
      result.action = String(ended.args?.action ?? "");
      break;
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
