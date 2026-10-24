import { Type, type Static, type TSchema } from "typebox";
import { ActionError, type BrowserSession } from "./browser.ts";
import {
  type Approval,
  type GatedAction,
  needsApproval,
  pinAction,
  samePinnedAction,
} from "./gate.ts";

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
  | "describe"
  | "inspect"
>;

export interface BrowserTool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  /** Observations return the page themselves; actions get a fresh snapshot appended by the batch. */
  observes?: boolean;
  /** Ends the browsing task: the user has to do something first, log in or approve an action. */
  ends?: Stop;
  /** The run's approvals: the action the user approved, if any, and what browser_confirm pinned. */
  run(session: Browser, args: Static<T>, approval: Approval): Promise<string>;
}

/** Why a task stopped before its answer. */
export type Stop = "needs-login" | "needs-confirmation";

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
    run: async (s, a, approval) => {
      await gate(s, approval, "browser_click", { kind: "click" }, a.ref);
      return s.click(a.ref, { double: a.double });
    },
  }),
  tool({
    name: "browser_type",
    description: "Replace the text in a field by ref. Set submit to press Enter afterwards.",
    parameters: Type.Object({
      ref: Ref,
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
    }),
    run: async (s, a, approval) => {
      await gate(s, approval, "browser_type", { kind: "type", submit: a.submit === true }, a.ref);
      return s.type(a.ref, a.text, { submit: a.submit });
    },
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
    run: async (s, a, approval) => {
      await gate(s, approval, "browser_press", { kind: "press", key: a.key }, a.ref);
      return s.press(a.key, a.ref);
    },
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
    ends: "needs-login",
    run: async (_s, a) => `Login needed on ${a.site}: ${a.reason}`,
  }),
  tool({
    name: "browser_confirm",
    description:
      "Stop and ask the user to approve one consequential action before you do it: buying, booking, sending a message or a form, signing up, posting, or entering their personal data. Get everything ready first, so the action is one click away. Say which tool you will use on which element: the approval covers that step only. Ends the task; once the user approves, you are started again on the same page, allowed to do exactly that action.",
    parameters: Type.Object({
      action: Type.String({
        minLength: 1,
        description:
          'Exactly what you will do and what it commits the user to, like: Click "Pay 1 290 kr" on sas.no to book OSL–BGO on 3 May, 07:05, for 1 adult.',
      }),
      tool: Type.Union(
        [
          Type.Literal("browser_click"),
          Type.Literal("browser_type"),
          Type.Literal("browser_press"),
        ],
        { description: "The tool you will do it with." },
      ),
      ref: Type.Optional(
        Type.String({
          description:
            "The ref of the element you will do it on, from the latest observation; for a key pressed into the focused element, leave it out.",
        }),
      ),
      key: Type.Optional(Type.String({ description: "With browser_press: the key, like Enter." })),
    }),
    observes: true,
    ends: "needs-confirmation",
    run: async (s, a, approval) => {
      // What the user approves is pinned now, while the element is in front of us.
      if (a.tool !== undefined)
        approval.asked = pinAction(
          a.tool,
          await s.inspect(a.ref),
          a.tool === "browser_press" ? (a.key ?? "") : undefined,
        );
      return `Waiting for the user to approve: ${a.action}`;
    },
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

/**
 * Holds an action that commits the user (`needsApproval`) until they approve it: unless it is the
 * very action they approved (same tool, element and site), it fails, telling the model to call
 * browser_confirm; if it is, it goes ahead and uses the approval up.
 */
async function gate(
  session: Browser,
  approval: Approval,
  tool: string,
  action: GatedAction,
  ref: string | undefined,
): Promise<void> {
  const target = await session.inspect(ref);
  const reason = target && needsApproval(action, target);
  if (!reason) return;
  const pinned = pinAction(tool, target, action.kind === "press" ? action.key : undefined);
  if (approval.approved && samePinnedAction(approval.approved, pinned)) {
    approval.approved = undefined;
    return;
  }
  const other = approval.approved ? " The user approved a different action, not this one." : "";
  throw new ActionError(
    `Not done: ${reason}, so the user has to approve it.${other} Get everything ready, then call browser_confirm with exactly this action, the tool and the element's ref, and what it commits them to.`,
  );
}

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
  ends?: Stop;
  /** What the call was given, for a stop that needs it. */
  args?: Record<string, unknown>;
}

/**
 * What a call is about to do, as one short line for people watching, like `Clicking "Search"…`.
 * Element names come from the latest observation; typed text and saved logins never show.
 */
export function progressLine(
  session: Pick<Browser, "describe">,
  call: Pick<ToolCallInput, "name" | "arguments">,
): string {
  const a = call.arguments;
  const text = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : "");
  const quote = (value: string) => `"${value.length > 60 ? `${value.slice(0, 59)}…` : value}"`;
  // `button "Search" [e12]` names the element "Search"; one without a name goes by its role.
  const element = () => {
    const line = session.describe(text("ref"));
    if (line === text("ref")) return "an element";
    const name = /"([^"]+)"/.exec(line)?.[1];
    return name === undefined ? `the ${line.split(/[\s:[]/)[0] || "element"}` : quote(name);
  };
  switch (call.name) {
    case "browser_observe":
      return "Reading the page…";
    case "browser_find":
      return `Looking for ${quote(text("query"))} on the page…`;
    case "browser_navigate": {
      const url = text("url");
      if (url === "back") return "Going back…";
      if (url === "forward") return "Going forward…";
      if (url === "reload") return "Reloading the page…";
      try {
        return `Opening ${new URL(url).hostname.replace(/^www\./, "")}…`;
      } catch {
        return "Opening a page…";
      }
    }
    case "browser_click":
      return `Clicking ${element()}…`;
    case "browser_type":
      return `Typing into ${element()}…`;
    case "browser_check":
      return `${a.checked === false ? "Unchecking" : "Checking"} ${element()}…`;
    case "browser_select":
      return `Choosing ${quote(text("option"))}…`;
    case "browser_press":
      return `Pressing ${text("key")}…`;
    case "browser_scroll":
      return text("ref") === "" ? `Scrolling ${text("direction")}…` : `Scrolling to ${element()}…`;
    case "browser_login":
      return "Logging in with the saved login…";
    case "browser_request_login":
      return `Asking you to log in on ${text("site")}…`;
    case "browser_confirm":
      return "Asking you to approve the next step…";
    case "browser_tabs":
      return text("action") === "switch"
        ? "Switching tabs…"
        : text("action") === "close"
          ? "Closing a tab…"
          : "Looking at the tabs…";
    default:
      return "Working…";
  }
}

/**
 * Run one model turn's calls in order. The first failure stops the rest, and the last call
 * that ran gets a fresh observation appended, so the model always ends the turn looking at the page.
 */
export async function runBatch(
  session: Browser,
  calls: readonly ToolCallInput[],
  /** Hears each call just before it runs. */
  onCall?: (call: ToolCallInput) => void,
  /** The user's approval this run carries, if any; see `Approval`. */
  approval: Approval = {},
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
        text: out.some((o) => o.ends === "needs-login")
          ? "Not run: the task stopped for a login."
          : out.some((o) => o.ends === "needs-confirmation")
            ? "Not run: the task stopped for the user's approval."
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
      onCall?.(call);
      const text = await definition.run(session, call.arguments as never, approval);
      if (!definition.observes) await session.settle();
      out.push({
        id: call.id,
        name: call.name,
        text,
        isError: false,
        ...(definition.ends ? { ends: definition.ends, args: call.arguments } : {}),
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
