import { ActionError } from "../src/browser.ts";
import type { ActionTarget } from "../src/gate.ts";
import type { Browser } from "../src/tools.ts";
import type { PageTool } from "../src/webmcp.ts";

/** A plain button, as `inspect` reads it; tests change what they need. */
export function target(overrides: Partial<ActionTarget> = {}): ActionTarget {
  return {
    tag: "button",
    type: "button",
    role: "",
    name: "Search",
    autocomplete: "",
    editable: false,
    navigates: false,
    submits: false,
    loggedIn: false,
    host: "example.no",
    ...overrides,
  };
}

/**
 * A browser that records what it was asked and shows a numbered page after every change.
 * `targets` are what `inspect` finds by ref (`focus` without one); others are plain buttons.
 */
export function fakeBrowser(
  page = (n: number) => `URL: https://example.no/${n}\n\n- heading "Page ${n}" [level=1]`,
  targets: Record<string, ActionTarget> = {},
  /** What the page offers through WebMCP. */
  pageTools: PageTool[] = [],
) {
  const calls: string[] = [];
  let n = 0;
  const browser: Browser = {
    observe: async () => page(n),
    find: async (query) => `- text: found ${query}`,
    navigate: async (url) => {
      calls.push(`navigate ${url}`);
      n++;
      return `Opened ${url}.`;
    },
    click: async (ref) => {
      calls.push(`click ${ref}`);
      if (ref === "e404") throw new ActionError("e404 is no longer on the page.");
      n++;
      return `Clicked ${ref}.`;
    },
    type: async (ref, text) => {
      calls.push(`type ${ref} ${text}`);
      return `Typed into ${ref}.`;
    },
    check: async (ref, checked) => `${checked ? "Checked" : "Unchecked"} ${ref}.`,
    select: async (ref, option) => `Selected ${option} in ${ref}.`,
    press: async (key) => `Pressed ${key}.`,
    scroll: async (direction) => `Scrolled ${direction}.`,
    tabs: async () => "1. Page — https://example.no (current)",
    settle: async () => {},
    takeNotes: () => [],
    describe: (ref) => `button "Button ${ref}" [${ref}]`,
    inspect: async (ref) => targets[ref ?? "focus"] ?? target({ name: `Button ${ref}` }),
    pageHost: () => "example.no",
    pageTools: async () => pageTools,
    callPageTool: async (name, input) => {
      calls.push(`page tool ${name} ${JSON.stringify(input)}`);
      return `${name} done.`;
    },
    login: async () => {
      calls.push("login");
      return "Filled in the saved login for example.no and submitted it.";
    },
  };
  return { browser, calls };
}
