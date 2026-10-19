import { ActionError } from "../src/session.ts";
import type { Desktop } from "../src/tools.ts";

/** A desktop that records what it was asked and shows a numbered window after every change. */
export function fakeDesktop(
  view = (n: number) => `- frame "Notes ${n}" (notes) [active] [e1]:\n  - button "Save" [e2]`,
) {
  const calls: string[] = [];
  let n = 0;
  const desktop: Desktop = {
    observe: async () => view(n),
    find: async (query) => `- text "found ${query}"`,
    launch: async (app) => {
      calls.push(`launch ${app}`);
      if (app !== "notes") throw new ActionError(`There is no app called "${app}".`);
      n++;
      return `Started ${app}.`;
    },
    click: async (ref) => {
      calls.push(`click ${ref}`);
      if (ref === "e404") throw new ActionError("There is no element e404.");
      n++;
      return `Clicked ${ref}.`;
    },
    type: async (ref, text) => {
      calls.push(`type ${ref} ${text}`);
      return `Typed into ${ref}.`;
    },
    select: async (ref, option) => `Selected "${option}" in ${ref}.`,
    press: async (keys) => `Pressed ${keys}.`,
    focusWindow: async (ref) => `Brought ${ref} to the front.`,
    settle: async () => {},
    describe: (ref) => `button "Button ${ref}" [${ref}]`,
  };
  return { desktop, calls };
}
