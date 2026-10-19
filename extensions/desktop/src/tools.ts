import { Type, type Static, type TSchema } from "typebox";
import { ActionError, type DesktopSession } from "./session.ts";

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
>;

export interface DesktopTool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  /** Observations return the desktop themselves; actions get a fresh one appended by the batch. */
  observes?: boolean;
  /** Ends the task: the user has to approve an action first. */
  ends?: Stop;
  run(desktop: Desktop, args: Static<T>): Promise<string>;
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
    run: (d, a) => d.click(a.ref, { double: a.double }),
  }),
  tool({
    name: "desktop_type",
    description:
      "Replace the text in a field by ref. Set submit to press Enter afterwards. Use \\n for new lines in a multi-line field.",
    parameters: Type.Object({
      ref: Ref,
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
    }),
    run: (d, a) => d.type(a.ref, a.text, { submit: a.submit }),
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
    run: (d, a) => d.press(a.keys, a.ref),
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
      "Stop and ask the user to approve one consequential action before you do it: sending, deleting, paying, publishing, or saving over an existing file. Get everything ready first, so the action is one click away. Ends the task; once the user approves, you are started again where you left off, allowed to do exactly that action.",
    parameters: Type.Object({
      action: Type.String({
        minLength: 1,
        description:
          'Exactly what you will do and what it commits the user to, like: Click "Send" in Thunderbird to send the reply to Kari about Friday\'s meeting.',
      }),
    }),
    observes: true,
    ends: "needs-confirmation",
    run: async (_d, a) => `Waiting for the user to approve: ${a.action}`,
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
      const text = await definition.run(desktop, call.arguments as never);
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
