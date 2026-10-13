import { ActionError } from "../src/browser.ts";
import type { Browser } from "../src/tools.ts";

/** A browser that records what it was asked and shows a numbered page after every change. */
export function fakeBrowser(
  page = (n: number) => `URL: https://example.no/${n}\n\n- heading "Page ${n}" [level=1]`,
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
    login: async () => {
      calls.push("login");
      return "Filled in the saved login for example.no and submitted it.";
    },
  };
  return { browser, calls };
}
