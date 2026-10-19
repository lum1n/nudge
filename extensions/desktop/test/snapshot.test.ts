import { describe, expect, it } from "vitest";
import { parseKeys, type State } from "../src/atspi.ts";
import { type DesktopNode, renderDesktop } from "../src/snapshot.ts";

let refs = 0;
const node = (
  role: string,
  name = "",
  extra: Partial<Omit<DesktopNode, "states">> & { states?: State[] } = {},
): DesktopNode => ({
  role,
  name,
  actionable: false,
  ref: `e${++refs}`,
  children: [],
  ...extra,
  states: new Set<State>(["showing", "visible", "enabled", "sensitive", ...(extra.states ?? [])]),
});
const button = (name: string, extra: Parameters<typeof node>[2] = {}) =>
  node("push button", name, { actionable: true, ...extra });

describe("the desktop snapshot", () => {
  it("lists controls with refs, lifts unnamed wrappers, and leaves out labels a control repeats", () => {
    const text = node("text", "", { actionable: true, states: ["editable"], text: "Trip to Bodø" });
    const window = node("frame", "Notes", {
      states: ["active"],
      children: [
        node("filler", "", {
          children: [
            node("filler", "", {
              children: [node("label", "Title"), { ...text, name: "Title" }],
            }),
            button("Save", { children: [node("label", "Save")] }),
            node("scroll bar", ""),
            node("label", "Nothing saved yet"),
          ],
        }),
      ],
    });
    expect(renderDesktop([{ app: "notes", node: window }]).text).toBe(
      [
        '- frame "Notes" (notes) [active] [e9]:',
        `  - textbox "Title" [${text.ref}]: Trip to Bodø`,
        `  - button "Save" [${window.children[0]!.children[1]!.ref}]`,
        '  - text "Nothing saved yet"',
      ].join("\n"),
    );
  });

  it("puts open dialogs first", () => {
    const main = node("frame", "Notes", { children: [button("Save")] });
    const dialog = node("alert", "Question", {
      states: ["modal"],
      children: [node("label", 'Save "Trip"?'), button("Cancel"), button("Save note")],
    });
    const text = renderDesktop([
      { app: "notes", node: main },
      { app: "notes", node: dialog },
    ]).text;
    expect(text.split("\n").slice(0, 6)).toEqual([
      "OPEN DIALOGS (they block their window; handle them first):",
      '- alert "Question" [modal] (notes) [e15]:',
      '  - text "Save "Trip"?"',
      `  - button "Cancel" [${dialog.children[1]!.ref}]`,
      `  - button "Save note" [${dialog.children[2]!.ref}]`,
      "",
    ]);
    expect(text).toContain('- frame "Notes" (notes) [e11]:');
  });

  it("never shows what a password field holds", () => {
    const window = node("frame", "Log in", {
      children: [
        node("password text", "Password", {
          actionable: true,
          states: ["editable"],
          text: "hunter2",
        }),
      ],
    });
    const snapshot = renderDesktop([{ app: "app", node: window }]);
    expect(snapshot.text).toContain('password "Password"');
    expect(snapshot.text).toContain("[hidden]");
    expect(snapshot.lines.join("\n")).not.toContain("hunter2");
  });

  it("reads a table row by row", () => {
    const cell = (name: string, states: State[] = []) => node("table cell", name, { states });
    const table = node("table", "Saved notes", {
      actionable: true,
      columns: 2,
      children: [
        node("table column header", "Title", { actionable: true }),
        node("table column header", "Category", { actionable: true }),
        cell("Groceries", ["selectable", "selected"]),
        cell("Home", ["selectable", "selected"]),
        cell("Standup"),
        cell("Work"),
      ],
    });
    const text = renderDesktop([
      { app: "notes", node: node("frame", "Notes", { children: [table] }) },
    ]).text;
    expect(text.split("\n").slice(1)).toEqual([
      `  - table "Saved notes" [${table.ref}]:`,
      '    - columns "Title · Category"',
      `    - row "Groceries · Home" [selected] [${table.children[2]!.ref}]`,
      `    - row "Standup · Work" [${table.children[4]!.ref}]`,
    ]);
  });

  it("shows states the agent needs: checked, disabled, focused, expanded, values", () => {
    const window = node("frame", "Settings", {
      children: [
        node("check box", "Pinned", { actionable: true, states: ["checkable", "checked"] }),
        button("Apply", { states: [] }),
        node("combo box", "Work", { actionable: true, states: ["expandable", "focused"] }),
        node("slider", "Volume", { actionable: true, value: 40 }),
      ],
    });
    (window.children[1]!.states as Set<State>).delete("sensitive");
    (window.children[1]!.states as Set<State>).delete("enabled");
    const lines = renderDesktop([{ app: "app", node: window }]).text.split("\n");
    expect(lines[1]).toMatch(/^ {2}- checkbox "Pinned" \[checked\] \[e\d+\]$/);
    expect(lines[2]).toMatch(/^ {2}- button "Apply" \[disabled\] \[e\d+\]$/);
    expect(lines[3]).toMatch(/^ {2}- combobox "Work" \[focused\] \[collapsed\] \[e\d+\]$/);
    expect(lines[4]).toMatch(/^ {2}- slider "Volume" \[value=40\] \[e\d+\]$/);
  });

  it("pages a long window, and says how to read on", () => {
    const window = node("frame", "List", {
      children: Array.from({ length: 50 }, (_, i) =>
        node("list", `Group ${i}`, {
          children: [node("list item", `Item ${i} ${"x".repeat(80)}`)],
        }),
      ),
    });
    const first = renderDesktop([{ app: "app", node: window }], { budget: 2_000 });
    expect(first.pages).toBeGreaterThan(1);
    expect(first.text).toContain("desktop_observe with page 2 reads on");
    expect(first.lines.some((l) => l.includes("Item 49"))).toBe(true);
  });

  it("says when a menu is open, which takes the keys and clicks", () => {
    const menu = (open: boolean) =>
      node("frame", "Notes", {
        children: [
          node("menu bar", "", {
            actionable: true,
            children: [
              node("menu", "File", {
                actionable: true,
                children: open ? [node("menu item", "Quit", { actionable: true })] : [],
              }),
            ],
          }),
        ],
      });
    expect(renderDesktop([{ app: "notes", node: menu(true) }]).text).toMatch(
      /^A MENU IS OPEN: .*press Escape to close it\.\n\n- frame "Notes"/,
    );
    expect(renderDesktop([{ app: "notes", node: menu(false) }]).text).not.toContain("MENU IS OPEN");
  });

  it("says when no window is open", () => {
    expect(renderDesktop([]).text).toMatch(/No windows are open/);
  });
});

describe("key combos", () => {
  it("map to an X keysym and a modifier mask", () => {
    expect(parseKeys("Enter")).toEqual({ keysym: 0xff0d, modifiers: 0 });
    expect(parseKeys("ctrl+s")).toEqual({ keysym: 0x73, modifiers: 4 });
    expect(parseKeys("Ctrl+Shift+S")).toEqual({ keysym: 0x73, modifiers: 5 });
    expect(parseKeys("alt+F4")).toEqual({ keysym: 0xffc1, modifiers: 8 });
    expect(parseKeys("ø")).toEqual({ keysym: 0xf8, modifiers: 0 });
    expect(parseKeys("€")).toEqual({ keysym: 0x010020ac, modifiers: 0 });
  });

  it("reject what they don't know", () => {
    expect(() => parseKeys("hyper+x")).toThrow(/Unknown modifier/);
    expect(() => parseKeys("ctrl+banana")).toThrow(/Unknown key/);
    expect(() => parseKeys("")).toThrow(/No key/);
  });
});
