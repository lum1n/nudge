import { consequentialLabel } from "@nudge/core";
import { Type, type Static, type TSchema } from "typebox";
import {
  ActionError,
  type Approval,
  type DesktopSession,
  type PinnedAction,
  type Surroundings,
} from "./session.ts";

/** The part of a desktop session the tools use; tests pass a fake. */
export type Desktop = Pick<
  DesktopSession,
  | "observe"
  | "find"
  | "launch"
  | "click"
  | "type"
  | "select"
  | "press"
  | "focusWindow"
  | "settle"
  | "describe"
  | "around"
  | "deletes"
>;

export interface DesktopTool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  /** Observations return the desktop themselves; actions get a fresh one appended by the batch. */
  observes?: boolean;
  /** Ends the task: the user has to approve an action first. */
  ends?: Stop;
  /** The run's approvals: the action the user approved, if any, and what desktop_confirm pinned. */
  run(desktop: Desktop, args: Static<T>, approval: Approval): Promise<string>;
}

/** Why a task stopped before its answer. */
export type Stop = "needs-confirmation";

const Ref = Type.String({ description: "Element ref from the latest observation, like e12." });

function tool<T extends TSchema>(definition: DesktopTool<T>): DesktopTool {
  return definition as unknown as DesktopTool;
}

export const desktopTools: DesktopTool[] = [
  tool({
    name: "desktop_observe",
    description:
      "Read the open windows as text: open menus and dialogs first, controls with refs, and their contents. Long views are split; pass page to read further.",
    parameters: Type.Object({ page: Type.Optional(Type.Integer({ minimum: 1 })) }),
    observes: true,
    run: (d, a) => d.observe(a.page ?? 1),
  }),
  tool({
    name: "desktop_find",
    description:
      "Search all open windows (every observation page) for lines containing every word of the query.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
    observes: true,
    run: (d, a) => d.find(a.query),
  }),
  tool({
    name: "desktop_launch",
    description: "Start one of the apps you were given, by its name, and wait for its window.",
    parameters: Type.Object({ app: Type.String({ minLength: 1 }) }),
    run: (d, a) => d.launch(a.app),
  }),
  tool({
    name: "desktop_click",
    description:
      "Click an element by ref: buttons, menus and menu items, tabs, list rows, checkboxes.",
    parameters: Type.Object({ ref: Ref, double: Type.Optional(Type.Boolean()) }),
    run: (d, a, approval) => {
      gate(d, approval, "desktop_click", a.ref, undefined, clickReason(d, a.ref));
      return d.click(a.ref, { double: a.double });
    },
  }),
  tool({
    name: "desktop_type",
    description:
      "Replace the text in a field by ref. Set submit to press Enter afterwards. Line breaks in text become new lines in a multi-line field.",
    parameters: Type.Object({
      ref: Ref,
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
    }),
    run: (d, a, approval) => {
      if (a.submit)
        gate(d, approval, "desktop_type", a.ref, undefined, submitReason(d.around(a.ref)));
      return d.type(a.ref, a.text, { submit: a.submit });
    },
  }),
  tool({
    name: "desktop_select",
    description: "Choose an option in a combo box or list by its visible name.",
    parameters: Type.Object({ ref: Ref, option: Type.String() }),
    run: (d, a) => d.select(a.ref, a.option),
  }),
  tool({
    name: "desktop_press",
    description:
      'Press a key or combo, like "Enter", "Escape", "Down", "ctrl+s" or "ctrl+shift+z", into an element when given, else into the window under the pointer.',
    parameters: Type.Object({ keys: Type.String({ minLength: 1 }), ref: Type.Optional(Ref) }),
    run: async (d, a, approval) => {
      gate(d, approval, "desktop_press", a.ref, a.keys, await keysReason(d, a.keys, a.ref));
      return d.press(a.keys, a.ref);
    },
  }),
  tool({
    name: "desktop_focus_window",
    description:
      "Bring a window to the front and give it the keyboard, by the ref of the window or of anything in it.",
    parameters: Type.Object({ ref: Ref }),
    run: (d, a) => d.focusWindow(a.ref),
  }),
  tool({
    name: "desktop_confirm",
    description:
      "Stop and ask the user to approve one consequential action before you do it: sending, deleting, paying, publishing, or saving over an existing file. Get everything ready first, so the action is one click away. Say which tool you will use on which element: the approval covers that step only. Ends the task; once the user approves, you are started again where you left off, allowed to do exactly that action.",
    parameters: Type.Object({
      action: Type.String({
        minLength: 1,
        description:
          'Exactly what you will do and what it commits the user to, like: Click "Send" in Thunderbird to send the reply to Kari about Friday\'s meeting.',
      }),
      tool: Type.Union(
        [
          Type.Literal("desktop_click"),
          Type.Literal("desktop_type"),
          Type.Literal("desktop_press"),
        ],
        { description: "The tool you will do it with." },
      ),
      ref: Type.Optional(
        Type.String({
          description:
            "The ref of the element you will do it on, from the latest observation; for keys pressed into whatever has the keyboard, leave it out.",
        }),
      ),
      keys: Type.Optional(
        Type.String({ description: "With desktop_press: the keys, like ctrl+Return." }),
      ),
    }),
    observes: true,
    ends: "needs-confirmation",
    run: async (d, a, approval) => {
      // What the user approves is pinned now, while the element is in front of us.
      if (a.tool !== undefined)
        approval.asked = pin(
          d,
          a.tool,
          a.ref,
          a.tool === "desktop_press" ? (a.keys ?? "") : undefined,
        );
      return `Waiting for the user to approve: ${a.action}`;
    },
  }),
];

/** Roles whose label says what using them does. */
const CONTROLS = new Set(["button", "toggle button", "switch", "menuitem", "link"]);
/** Keys that press the button they are given. */
const ACTIVATE_KEYS = /^(?:enter|return|kp_enter|space)$/i;
const ENTER = /^(?:enter|return|kp_enter)$/i;
/** Control+Enter sends in mail and chat apps (Thunderbird, Evolution, Element…). */
const SEND_KEYS = /^(?:ctrl|control)\s*\+\s*(?:enter|return|kp_enter)$/i;
const SAVE_KEYS = /^(?:ctrl|control)\s*\+\s*s$/i;
/** Save itself, not Save As, which asks where. */
const SAVE = /^(?:save|lagre)(?:\s*\(.*\))?$/i;
/** What an app asks before it writes over a file. */
const OVERWRITE =
  /already exists|replace (?:it|the existing)|overwrite|finnes (?:allerede|fra før)|erstatte (?:den|eksisterende)|overskriv/i;
/** Buttons that say no to it. */
const DECLINE = /^(?:cancel|no|don't replace|do not replace|avbryt|nei|ikke erstatt|close|lukk)$/i;
/** Text fields where Enter only finds or goes somewhere. */
const SEARCHY =
  /search|find|filter|søk|finn|filtrer|location|url|go to|gå til|path|file ?name|filnavn|^name$|^navn$/i;
const TEXT_FIELDS = new Set(["textbox", "password", "combobox", "spinbutton"]);
/** A file name in a window title, like `notes.txt - gedit` or `*Rapport.odt`. */
const FILE_IN_TITLE = /(?:^|[\s*•(])([^\s@/\\*()]+\.[a-z][a-z0-9]{0,4})(?=$|[\s)\]—–-])/i;
const UNTITLED = /untitled|uten navn|navnløs|ikke lagret|unsaved/i;

/** The role and name in a line of the view, like `button "Send" [e12]` or `button "Send"`. */
function parse(line: string): { role: string; name: string } {
  const [, role = "", name = ""] = /^(.+?)(?: "(.*)")?(?: \[[^\]]+\])?$/.exec(line) ?? [];
  return { role, name };
}

/**
 * Why using an element commits the user, or undefined: a button, menu item or link whose label
 * says it pays, sends, deletes, publishes… (`consequentialLabel`). `line` is how the latest view
 * showed it, like `button "Send" [e12]`.
 */
export function consequentialControl(line: string): string | undefined {
  if (!/ \[[^\]]+\]$/.test(line)) return undefined;
  const { role, name } = parse(line);
  const word = CONTROLS.has(role) ? consequentialLabel(name) : undefined;
  return word === undefined ? undefined : `"${name}" commits the user to something ("${word}")`;
}

/**
 * Why activating `element` (clicking it, or Enter or Space on it) in its window writes over a
 * file, or undefined: any but a No or Cancel button in a window asking whether to replace a file
 * that exists, and Save in a window whose title names the file it has open.
 */
export function overwriteReason(around: Surroundings | undefined): string | undefined {
  if (around === undefined) return undefined;
  const { role, name } = parse(around.element);
  if (!CONTROLS.has(role)) return undefined;
  if (OVERWRITE.test(around.text) && !DECLINE.test(name.trim()))
    return "it replaces a file that already exists";
  if (SAVE.test(name.trim())) return savesOver(around);
  return undefined;
}

/** Why saving the window's document writes over a file, or undefined: its title names one. */
function savesOver(around: Surroundings): string | undefined {
  const title = parse(around.window).name;
  const file = FILE_IN_TITLE.exec(title)?.[1];
  if (file === undefined || UNTITLED.test(title)) return undefined;
  return `saving writes over "${file}", which already exists`;
}

/**
 * Why Enter in a text field may commit the user, or undefined: it sends what was typed, like a
 * chat message or a form, unless the field is for searching, finding or going somewhere.
 */
export function submitReason(around: Surroundings | undefined): string | undefined {
  const name = around === undefined ? "" : parse(around.element).name.trim();
  if (name !== "" && SEARCHY.test(name)) return undefined;
  return "Enter in this field may send what was typed, like a message or a form";
}

function clickReason(desktop: Desktop, ref: string): string | undefined {
  return consequentialControl(desktop.describe(ref)) ?? overwriteReason(desktop.around(ref));
}

/** Why pressing `keys`, into `ref` when given, else into what has the keyboard, commits the user. */
async function keysReason(
  desktop: Desktop,
  keys: string,
  ref?: string,
): Promise<string | undefined> {
  const pressed = keys.trim();
  if (SEND_KEYS.test(pressed)) return `${keys} sends what is being written in mail and chat apps`;
  if (await desktop.deletes(pressed, ref)) return `${keys} here deletes what is selected`;
  const around = desktop.around(ref);
  if (SAVE_KEYS.test(pressed))
    return around === undefined
      ? `${keys} may save over a file, and it isn't known which window gets it; pass the ref of something in that window`
      : savesOver(around);
  if (!ACTIVATE_KEYS.test(pressed)) return undefined;
  const role = around === undefined ? "" : parse(around.element).role;
  if (ENTER.test(pressed) && TEXT_FIELDS.has(role) && !around!.multiLine)
    return submitReason(around);
  return (
    (ref === undefined ? undefined : consequentialControl(desktop.describe(ref))) ??
    overwriteReason(around)
  );
}

/** Pins what `tool` is about to do, for an `Approval`. */
function pin(desktop: Desktop, tool: string, ref?: string, keys?: string): PinnedAction {
  const around = desktop.around(ref);
  const element =
    around?.element ?? (ref === undefined ? "" : desktop.describe(ref).replace(/ \[[^\]]+\]$/, ""));
  return {
    tool,
    ...(keys === undefined ? {} : { keys: keys.toLowerCase().replace(/\s+/g, "") }),
    window: around?.window ?? "",
    element,
  };
}

/**
 * Holds an action that commits the user until they approve it: unless it is the very action they
 * approved (same tool, keys, element and window), it fails, telling the model to call
 * desktop_confirm; if it is, it goes ahead and uses the approval up.
 */
function gate(
  desktop: Desktop,
  approval: Approval,
  tool: string,
  ref: string | undefined,
  keys: string | undefined,
  reason: string | undefined,
): void {
  if (reason === undefined) return;
  const pinned = pin(desktop, tool, ref, keys);
  const approved = approval.approved;
  if (
    approved &&
    approved.tool === pinned.tool &&
    approved.keys === pinned.keys &&
    approved.window === pinned.window &&
    approved.element === pinned.element
  ) {
    approval.approved = undefined;
    return;
  }
  const other = approved ? " The user approved a different action, not this one." : "";
  throw new ActionError(
    `Not done: ${reason}, so the user has to approve it.${other} Get everything ready, then call desktop_confirm with exactly this action, the tool and the element's ref, and what it commits them to.`,
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
  /** The task has to stop here; see `DesktopTool.ends`. */
  ends?: Stop;
  /** What the call was given, for a stop that needs it. */
  args?: Record<string, unknown>;
}

/**
 * What a call is about to do, as one short line for people watching, like `Clicking "Save"…`.
 * Element names come from the latest observation; typed text never shows.
 */
export function progressLine(
  desktop: Pick<Desktop, "describe">,
  call: Pick<ToolCallInput, "name" | "arguments">,
): string {
  const a = call.arguments;
  const text = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : "");
  const quote = (value: string) => `"${value.length > 60 ? `${value.slice(0, 59)}…` : value}"`;
  // `button "Save" [e12]` names the element "Save"; one without a name goes by its role.
  const element = () => {
    const line = desktop.describe(text("ref"));
    if (line === text("ref")) return "an element";
    const name = /"([^"]+)"/.exec(line)?.[1];
    return name === undefined ? `the ${line.split(/[\s:[]/)[0] || "element"}` : quote(name);
  };
  switch (call.name) {
    case "desktop_observe":
      return "Reading the windows…";
    case "desktop_find":
      return `Looking for ${quote(text("query"))}…`;
    case "desktop_launch":
      return `Starting ${text("app")}…`;
    case "desktop_click":
      return `Clicking ${element()}…`;
    case "desktop_type":
      return `Typing into ${element()}…`;
    case "desktop_select":
      return `Choosing ${quote(text("option"))}…`;
    case "desktop_press":
      return `Pressing ${text("keys")}…`;
    case "desktop_focus_window":
      return `Switching to ${element()}…`;
    case "desktop_confirm":
      return "Asking you to approve the next step…";
    default:
      return "Working…";
  }
}

/**
 * Run one model turn's calls in order. The first failure stops the rest, and the last call that
 * ran gets a fresh observation appended, so the model always ends the turn looking at the windows.
 */
export async function runBatch(
  desktop: Desktop,
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
    const definition = desktopTools.find((t) => t.name === call.name);
    if (failed) {
      out.push({
        id: call.id,
        name: call.name,
        text: out.some((o) => o.ends === "needs-confirmation")
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
      const text = await definition.run(desktop, call.arguments as never, approval);
      if (!definition.observes) await desktop.settle();
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
    const view = await desktop
      .observe()
      .catch((error: unknown) => `(Could not read the windows: ${String(error).split("\n")[0]})`);
    last.text = [last.text, "", view].join("\n");
  }
  return out;
}
