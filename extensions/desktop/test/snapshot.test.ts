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

  it("puts a field with the keyboard that no window shows first, with its ref", () => {
    const main = node("frame", "Documents — Dolphin", {
      states: ["active"],
      children: [node("list item", "utkast.txt", { actionable: true, states: ["selected"] })],
    });
    const field = node("text", "", {
      actionable: true,
      states: ["editable", "focused"],
      text: "utkast.txt",
    });
    const snapshot = renderDesktop([
      { app: "dolphin", node: main },
      { app: "dolphin", node: field, editing: true },
    ]);
    expect(snapshot.text.split("\n").slice(0, 5)).toEqual([
      "THE KEYBOARD IS IN A FIELD the windows below leave out (like a file's name being renamed):",
      `- textbox [focused] [${field.ref}]: utkast.txt (dolphin)`,
      "Type into it by its ref; submit (Enter) commits it, Escape cancels.",
      "",
      `- frame "Documents — Dolphin" (dolphin) [active] [${main.ref}]:`,
    ]);
    expect(snapshot.lines[0]).toContain(`[${field.ref}]: utkast.txt`);
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
      `- alert "Question" [modal] (notes) [${dialog.ref}]:`,
      '  - text "Save "Trip"?"',
      `  - button "Cancel" [${dialog.children[1]!.ref}]`,
      `  - button "Save note" [${dialog.children[2]!.ref}]`,
      "",
    ]);
    expect(text).toContain(`- frame "Notes" (notes) [${main.ref}]:`);
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

  it("puts a dialog open inside its window first, as libadwaita shows them", () => {
    const window = node("frame", "Editor", {
      children: [
        node("text", "", { actionable: true, states: ["editable"], text: "Hei" }),
        node("dialog", "Preferences", { children: [button("Close")] }),
      ],
    });
    const text = renderDesktop([{ app: "editor", node: window }]).text;
    expect(text).toMatch(/^OPEN DIALOGS.*\n- dialog "Preferences" .*\n {2}- button "Close"/);
    expect(text.indexOf('frame "Editor"')).toBeGreaterThan(text.indexOf('dialog "Preferences"'));
  });

  it("leaves out what Qt and Firefox say that says nothing", () => {
    const window = node("frame", "Files", {
      children: [
        // An empty section with an action, a separator, a closed combo box's options.
        node("section", "", { actionable: true }),
        node("separator", "", { actionable: true }),
        node("combo box", "Zoom", {
          actionable: true,
          text: "100%",
          children: [node("list", "", { children: [node("list item", "200%")] })],
        }),
        // A value on a menu item says nothing; on a slider it does.
        node("menu item", "Open", { actionable: true, value: 0 }),
        node("slider", "Volume", { actionable: true, value: 40 }),
        // A control that only wraps one of its name, as GTK 4's menu buttons do.
        node("push button", "Main Menu", {
          children: [node("toggle button", "Main Menu", { actionable: true })],
        }),
      ],
    });
    const empty = node("alert", "");
    const text = renderDesktop([
      { app: "files", node: window },
      { app: "files", node: empty },
    ]).text;
    expect(text).not.toMatch(/section|separator|200%|OPEN DIALOGS/);
    expect(text).toMatch(/combobox "Zoom" \[e\d+\]: 100%$/m);
    expect(text).toMatch(/menuitem "Open" \[e\d+\]$/m);
    expect(text).toMatch(/slider "Volume" \[value=40\]/);
    expect(text).not.toMatch(/button "Main Menu"/);
    expect(text).toMatch(/switch "Main Menu" \[e\d+\]/);
  });

  it("puts a table's rows on a line each, from a browser's rows or Qt's tree items", () => {
    const cell = (name: string) => node("table cell", name);
    const html = node("table", "", {
      columns: 2,
      children: [
        node("table row", "", { children: [cell("Vare"), cell("Pris")] }),
        node("table row", "", { children: [cell("Kaffe"), cell("89 kr")] }),
      ],
    });
    const item = (name: string) => node("tree item", name, { actionable: true });
    const tree = node("tree", "Files", {
      columns: 2,
      children: [item("budsjett.csv"), item("91 bytes"), item("notat.txt"), item("12 bytes")],
    });
    const window = node("frame", "Lists", { children: [html, tree] });
    const text = renderDesktop([{ app: "x", node: window }]).text;
    expect(text).toMatch(/row "Vare · Pris"/);
    expect(text).toMatch(/row "Kaffe · 89 kr"/);
    expect(text).toMatch(/row "budsjett\.csv · 91 bytes" \[e\d+\]/);
    expect(text).toMatch(/row "notat\.txt · 12 bytes" \[e\d+\]/);
  });

  it("says a menu is open when its items sit inside wrappers (GTK 4) or it pops up (Qt)", () => {
    const items = [node("menu item", "Reset", { actionable: true })];
    const gtk4 = node("frame", "Counter", {
      children: [node("menu", "Main Menu", { children: [node("panel", "", { children: items })] })],
    });
    const qt = node("popup menu", "Dolphin", { children: items });
    expect(renderDesktop([{ app: "c", node: gtk4 }]).text).toMatch(/^A MENU IS OPEN/);
    expect(renderDesktop([{ app: "d", node: qt }]).text).toMatch(/^A MENU IS OPEN/);
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
