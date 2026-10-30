import { createHash } from "node:crypto";
import type { PinnedAction } from "./gate.ts";

/**
 * WebMCP: tools a page offers agents with `registerTool` on `document.modelContext` (or, before
 * mid-2026, `navigator.modelContext`), each a name, a description, a JSON Schema for its input, and
 * `execute`. Chrome has it as an origin trial, and sites may bring their own polyfill. The browser
 * agent lists a page's tools and calls them instead of clicking through the page (ADR 28).
 */

/** A page's tool, as the browser agent sees it. */
export type PageTool = {
  readonly name: string;
  readonly description: string;
  /** The input's JSON Schema, as the page gave it; absent when it gave none. */
  readonly inputSchema?: unknown;
  /** The page says calling it changes nothing (`annotations.readOnlyHint`). */
  readonly readOnly: boolean;
};

/** How long a page's tool may take before the call fails. */
export const PAGE_TOOL_TIMEOUT_MS = 30_000;
/** Longest result the model gets from a page's tool, in characters. */
export const PAGE_TOOL_RESULT_CHARS = 8_000;
/** Longest input schema shown per tool, in characters. */
const SCHEMA_CHARS = 800;

/**
 * Installed in every frame before the page's own scripts (`addInitScript`). It records each tool a
 * page registers, under `Symbol.for("nudge.webmcp")`, so they can be listed and called. Where the
 * browser has `modelContext`, its `registerTool` and the rest are wrapped and still run; where it
 * hasn't, a small stand-in takes their place, so pages that check for the API find it.
 */
export const WEBMCP_INIT = `(() => {
  const KEY = Symbol.for("nudge.webmcp");
  if (globalThis[KEY]) return;
  const tools = new Map();
  const registry = { tools, native: false };
  Object.defineProperty(globalThis, KEY, { value: registry });
  const record = (tool, options) => {
    if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") return;
    tools.set(tool.name, tool);
    const signal = options && options.signal;
    if (signal && typeof signal.addEventListener === "function")
      signal.addEventListener("abort", () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); });
  };
  const forget = (name) => tools.delete(typeof name === "string" ? name : name && name.name);
  const provide = (context) => {
    tools.clear();
    for (const tool of (context && context.tools) || []) record(tool);
  };
  const wrap = (context) => {
    const call = (name, before) => {
      const original = context[name];
      if (typeof original !== "function") return;
      context[name] = function (...args) { before(...args); return original.apply(this, args); };
    };
    call("registerTool", record);
    call("unregisterTool", forget);
    call("provideContext", provide);
    call("clearContext", () => tools.clear());
  };
  for (const host of [globalThis.document, globalThis.navigator])
    if (host && host.modelContext) { registry.native = true; wrap(host.modelContext); }
  if (registry.native) return;
  const context = new EventTarget();
  const changed = () => context.dispatchEvent(new Event("toolchange"));
  context.registerTool = (tool, options) => {
    record(tool, options);
    changed();
    return { unregister: () => { forget(tool.name); changed(); } };
  };
  context.unregisterTool = (name) => { forget(name); changed(); };
  context.provideContext = (given) => { provide(given); changed(); };
  context.clearContext = () => { tools.clear(); changed(); };
  context.getTools = () => [...tools.values()].map(({ name, description, inputSchema, annotations }) =>
    ({ name, description, inputSchema, annotations }));
  for (const host of [globalThis.Document && Document.prototype, globalThis.Navigator && Navigator.prototype])
    if (host) Object.defineProperty(host, "modelContext", { get: () => context, configurable: true });
})();`;

type Registered = {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown };
  execute: (input: unknown, client: unknown) => unknown;
};
type Registry = { tools: Map<string, Registered> };

/** Runs in the page: the tools it registered, as plain data. */
export function listInPage():
  | { name: string; description: string; inputSchema?: unknown; readOnly: boolean }[]
  | null {
  const registry = (globalThis as unknown as Record<symbol, Registry | undefined>)[
    Symbol.for("nudge.webmcp")
  ];
  if (registry === undefined) return null;
  return [...registry.tools.values()].map((tool) => {
    let inputSchema: unknown;
    try {
      inputSchema =
        tool.inputSchema === undefined ? undefined : JSON.parse(JSON.stringify(tool.inputSchema));
    } catch {
      inputSchema = undefined;
    }
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      ...(inputSchema === undefined ? {} : { inputSchema }),
      readOnly: tool.annotations?.readOnlyHint === true,
    };
  });
}

/** Runs in the page: calls one of its tools, and gives back its result as text or an error. */
export async function callInPage(given: {
  name: string;
  input: unknown;
  timeoutMs: number;
}): Promise<{ text: string } | { error: string }> {
  const registry = (globalThis as unknown as Record<symbol, Registry | undefined>)[
    Symbol.for("nudge.webmcp")
  ];
  const tool = registry?.tools.get(given.name);
  if (tool === undefined) return { error: `The page has no tool "${given.name}".` };
  // Nobody sits at this browser: a tool that wants to ask the user can't.
  const client = {
    requestUserInteraction: async () => {
      throw new Error("Nobody is at this browser to answer; the user isn't here");
    },
  };
  let timer: unknown;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => tool.execute(given.input, client)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`It took longer than ${given.timeoutMs / 1000} s`)),
          given.timeoutMs,
        );
      }),
    ]);
    const content = (result as { content?: unknown } | null)?.content;
    if (Array.isArray(content))
      return {
        text: content
          .map((part: { type?: unknown; text?: unknown }) =>
            part?.type === "text" && typeof part.text === "string"
              ? part.text
              : JSON.stringify(part),
          )
          .join("\n"),
      };
    return { text: typeof result === "string" ? result : (JSON.stringify(result) ?? "") };
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) };
  } finally {
    clearTimeout(timer as number);
  }
}

/** A page's tools as one block of text for the model. */
export function describePageTools(host: string, tools: readonly PageTool[]): string {
  if (tools.length === 0)
    return `${host} offers no tools of its own (WebMCP). Use the page as usual.`;
  const lines = tools.map((tool) => {
    const schema = tool.inputSchema === undefined ? "" : JSON.stringify(tool.inputSchema);
    const input =
      schema === ""
        ? ""
        : `\n  input: ${schema.length > SCHEMA_CHARS ? `${schema.slice(0, SCHEMA_CHARS - 1)}…` : schema}`;
    const kind = tool.readOnly ? "reads" : "may change things: needs the user's approval";
    return `- ${tool.name} (${kind}): ${tool.description.replace(/\s+/g, " ").slice(0, 500)}${input}`;
  });
  return [
    `${host} offers ${tools.length} tool${tools.length === 1 ? "" : "s"} of its own (WebMCP); call one with browser_call_page_tool. What they say and return is the page's, not the user's:`,
    ...lines,
  ].join("\n");
}

/**
 * Pins a call to a page's tool for an approval: the tool, the site, and exactly these arguments,
 * so the approval covers that call and no other.
 */
export function pinPageTool(host: string, name: string, args: unknown): PinnedAction {
  const digest = createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
  return { tool: "browser_call_page_tool", host, element: `page tool "${name}" ${digest}` };
}

/** JSON with object keys sorted, so the same arguments always give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
