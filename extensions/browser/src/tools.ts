import { Type, type Static, type TSchema } from "typebox";
import { ActionError, type BrowserSession } from "./browser.ts";

/** The part of a browser session the tools use; tests pass a fake. */
export type Browser = Pick<
  BrowserSession,
  | "observe"
  | "find"
  | "navigate"
  | "click"
  | "type"
  | "check"
  | "select"
  | "press"
  | "scroll"
  | "tabs"
  | "settle"
  | "takeNotes"
  | "login"
>;

export interface BrowserTool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  /** Observations return the page themselves; actions get a fresh snapshot appended by the batch. */
  observes?: boolean;
  /** Ends the browsing task: the user has to do something first. */
  ends?: boolean;
  run(session: Browser, args: Static<T>): Promise<string>;
}

const Ref = Type.String({
  description: "Element ref from the latest observation, like e12 or f3e40.",
});

function tool<T extends TSchema>(definition: BrowserTool<T>): BrowserTool {
  return definition as unknown as BrowserTool;
}

export const browserTools: BrowserTool[] = [
  tool({
    name: "browser_observe",
    description:
      "Read the current page as text: URL, open dialogs, controls with refs, and content. Long pages are split; pass page to read further.",
    parameters: Type.Object({ page: Type.Optional(Type.Integer({ minimum: 1 })) }),
    observes: true,
    run: (s, a) => s.observe(a.page ?? 1),
  }),
  tool({
    name: "browser_find",
    description:
      "Search the whole current page (all observation pages) for lines containing every word of the query.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
    observes: true,
    run: (s, a) => s.find(a.query),
  }),
  tool({
    name: "browser_navigate",
    description:
      'Open a URL in the current tab, or "back", "forward", "reload". Changing a site\'s search URL parameters is often faster than clicking filters.',
    parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
    run: (s, a) => s.navigate(a.url),
  }),
  tool({
    name: "browser_click",
    description: "Click an element by ref.",
    parameters: Type.Object({ ref: Ref, double: Type.Optional(Type.Boolean()) }),
    run: (s, a) => s.click(a.ref, { double: a.double }),
  }),
  tool({
    name: "browser_type",
    description: "Replace the text in a field by ref. Set submit to press Enter afterwards.",
    parameters: Type.Object({
      ref: Ref,
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
    }),
    run: (s, a) => s.type(a.ref, a.text, { submit: a.submit }),
  }),
  tool({
    name: "browser_check",
    description:
      "Set a checkbox, radio button or switch to checked or unchecked. Does nothing if it already is.",
    parameters: Type.Object({ ref: Ref, checked: Type.Boolean() }),
    run: (s, a) => s.check(a.ref, a.checked),
  }),
  tool({
    name: "browser_select",
    description: "Choose an option in a native dropdown (combobox) by its visible label.",
    parameters: Type.Object({ ref: Ref, option: Type.String() }),
    run: (s, a) => s.select(a.ref, a.option),
  }),
  tool({
    name: "browser_press",
    description:
      'Press a key or chord, like "Enter", "Escape", "ArrowDown" or "Control+A", optionally in an element.',
    parameters: Type.Object({ key: Type.String(), ref: Type.Optional(Ref) }),
    run: (s, a) => s.press(a.key, a.ref),
  }),
  tool({
    name: "browser_scroll",
    description:
      "Scroll the page up or down by most of a screen, or scroll an element into view by ref.",
    parameters: Type.Object({
      direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
      ref: Type.Optional(Ref),
    }),
    run: (s, a) => s.scroll(a.direction, a.ref),
  }),
  tool({
    name: "browser_login",
    description:
      "Log in with the login the user saved for this site: fills in the username and password on the login form and submits. You never see them. If none is saved, or a code or BankID is asked for, use browser_request_login.",
    parameters: Type.Object({}),
    run: (s) => s.login(),
  }),
  tool({
    name: "browser_request_login",
    description:
      "Stop and ask the user to log in themselves in the live view of this browser, when a site needs a login you cannot do with browser_login. Ends the task; the user will ask again once logged in.",
    parameters: Type.Object({
      site: Type.String({ description: "The site that needs the login, like finn.no" }),
      reason: Type.String({ description: "What the login is needed for" }),
    }),
    observes: true,
    ends: true,
    run: async (_s, a) => `Login needed on ${a.site}: ${a.reason}`,
  }),
  tool({
    name: "browser_tabs",
    description: "List the open tabs, switch to one, or close one (tabs are numbered from 1).",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("switch"), Type.Literal("close")]),
      index: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    run: (s, a) => s.tabs(a.action, a.index),
  }),
];

export interface ToolCallInput {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallOutput {
  id: string;
  name: string;
  text: string;
  isError: boolean;
  /** The task has to stop here; see `BrowserTool.ends`. */
  ends?: boolean;
}

/**
 * Run one model turn's calls in order. The first failure stops the rest, and the last call
 * that ran gets a fresh observation appended, so the model always ends the turn looking at the page.
 */
export async function runBatch(
  session: Browser,
  calls: readonly ToolCallInput[],
): Promise<ToolCallOutput[]> {
  const out: ToolCallOutput[] = [];
  let failed = false;
  let lastObserved = false;
  for (const call of calls) {
    const definition = browserTools.find((t) => t.name === call.name);
    if (failed) {
      out.push({
        id: call.id,
        name: call.name,
        text: out.some((o) => o.ends)
          ? "Not run: the task stopped for a login."
          : "Not run: an earlier action in this turn failed.",
        isError: true,
      });
      continue;
    }
    if (!definition) {
      out.push({ id: call.id, name: call.name, text: `Unknown tool ${call.name}.`, isError: true });
      failed = true;
      continue;
    }
    try {
      const text = await definition.run(session, call.arguments as never);
      if (!definition.observes) await session.settle();
      out.push({
        id: call.id,
        name: call.name,
        text,
        isError: false,
        ...(definition.ends ? { ends: true } : {}),
      });
      lastObserved = Boolean(definition.observes);
      if (definition.ends) failed = true;
    } catch (error) {
      failed = true;
      const text =
        error instanceof ActionError ? error.message : `Failed: ${String(error).split("\n")[0]}`;
      out.push({ id: call.id, name: call.name, text, isError: true });
      lastObserved = false;
    }
  }
  const last = [...out].reverse().find((o) => !o.text.startsWith("Not run:"));
  if (last && !lastObserved) {
    const notes = session.takeNotes();
    const snapshot = await session
      .observe()
      .catch((error: unknown) => `(Could not read the page: ${String(error).split("\n")[0]})`);
    last.text = [last.text, ...notes, "", snapshot].join("\n");
  }
  return out;
}
