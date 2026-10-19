// Turns the accessibility tree of a desktop's windows into the compact text the desktop agent
// reads: one line per control or text, refs on what it can act on, open dialogs first.
import type { State } from "./atspi.ts";

/** One accessible as the renderer sees it, read from AT-SPI (or built by a test). */
export interface DesktopNode {
  role: string;
  name: string;
  states: ReadonlySet<State>;
  /** Whether the agent can act on it: it has actions, editable text or a selection. */
  actionable: boolean;
  ref?: string;
  text?: string;
  value?: number;
  children: DesktopNode[];
  /** Columns of a table: its cells are listed row by row. */
  columns?: number;
  /** Children left unread, past the per-node limit. */
  unread?: number;
}

export interface DesktopWindow {
  /** The app's name on the accessibility bus. */
  app: string;
  node: DesktopNode;
}

export interface DesktopSnapshot {
  text: string;
  /** Every rendered line, unbudgeted, for `find`. */
  lines: string[];
  pages: number;
  dialogs: number;
}

/** AT-SPI role names, shortened to what models know from the web. */
const ROLES: Record<string, string> = {
  "push button": "button",
  "check box": "checkbox",
  "radio button": "radio",
  "combo box": "combobox",
  "page tab": "tab",
  "page tab list": "tablist",
  "spin button": "spinbutton",
  "table cell": "cell",
  "column header": "columnheader",
  "row header": "rowheader",
  "table column header": "columnheader",
  "table row header": "rowheader",
  "table row": "row",
  "tree table": "table",
  "list item": "listitem",
  "tree item": "treeitem",
  "menu bar": "menubar",
  "menu item": "menuitem",
  "check menu item": "menuitemcheckbox",
  "radio menu item": "menuitemradio",
  "tool bar": "toolbar",
  "status bar": "status",
  "progress bar": "progressbar",
  "scroll bar": "scrollbar",
  "toggle button": "switch",
  entry: "textbox",
  "password text": "password",
  label: "text",
  static: "text",
  paragraph: "text",
  "document text": "document",
  "document frame": "document",
};

/** Containers that say nothing themselves; unnamed ones are left out and their children lifted. */
const WRAPPERS = new Set([
  "filler",
  "panel",
  "scroll pane",
  "viewport",
  "layered pane",
  "split pane",
  "section",
  "grouping",
  "form",
  "unknown",
  "redundant object",
  "invalid",
  "internal frame",
  "option pane",
  "glass pane",
  "root pane",
  "embedded",
]);
const DIALOGS = new Set(["dialog", "alert", "file chooser", "color chooser", "font chooser"]);
/** The scrollbars, separators and images that only add noise. */
const SKIPPED = new Set(["scroll bar", "separator", "image", "icon", "ruler"]);
/** Roles that get a ref even without actions of their own: the pointer can click them. */
const CLICKABLE = new Set([
  "textbox",
  "tab",
  "listitem",
  "treeitem",
  "cell",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "menu",
  "link",
]);
/** Most children shown per node; the rest are counted, and `find` still searches them. */
const SHOWN_CHILDREN = 60;
const MAX_TEXT = 4_000;

/** The role shown for a node. */
export function roleOf(node: Pick<DesktopNode, "role" | "states">): string {
  if (node.role === "text") return node.states.has("editable") ? "textbox" : "text";
  return ROLES[node.role] ?? node.role;
}

function attrs(node: DesktopNode, role: string): string[] {
  const out: string[] = [];
  const s = node.states;
  const checkable =
    s.has("checkable") || /checkbox|radio|switch|menuitem(checkbox|radio)/.test(role);
  if (checkable && (s.has("checked") || s.has("pressed"))) out.push("checked");
  if (s.has("indeterminate")) out.push("mixed");
  if (node.actionable && !(s.has("sensitive") || s.has("enabled"))) out.push("disabled");
  if (s.has("focused")) out.push("focused");
  if (s.has("selectable") && s.has("selected")) out.push("selected");
  if (s.has("expandable")) out.push(s.has("expanded") ? "expanded" : "collapsed");
  if (role === "textbox" && s.has("multi-line")) out.push("multi-line");
  if (s.has("read-only") && role === "textbox") out.push("read-only");
  if (s.has("required")) out.push("required");
  if (s.has("invalid-entry")) out.push("invalid");
  if (s.has("modal")) out.push("modal");
  if (node.value !== undefined && Number.isFinite(node.value)) out.push(`value=${node.value}`);
  return out;
}

/** The text a node shows beyond its name: a field's contents, a document's text. Passwords never. */
function textOf(node: DesktopNode, role: string): string | undefined {
  if (role === "password") return node.text ? "[hidden]" : undefined;
  const text = node.text?.replace(/\u{fffc}/gu, "").trim();
  if (!text || text === node.name.trim()) return undefined;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (${text.length} characters)` : text;
}

function line(node: DesktopNode): string {
  const role = roleOf(node);
  let out = role;
  if (node.name) out += ` "${node.name}"`;
  for (const attr of attrs(node, role)) out += ` [${attr}]`;
  if (node.ref && (node.actionable || CLICKABLE.has(role))) out += ` [${node.ref}]`;
  const text = textOf(node, role);
  if (text !== undefined) out += text.includes("\n") ? `:\n${indentText(text)}` : `: ${text}`;
  return out;
}

function indentText(text: string): string {
  return text
    .split("\n")
    .map((l) => `    | ${l}`)
    .join("\n");
}

/** Leaves the noise out, and lifts the children of unnamed wrappers into their parent. */
function simplify(node: DesktopNode): DesktopNode[] {
  if (SKIPPED.has(node.role) && !node.actionable) return [];
  // Labels that only repeat a name already shown: the parent's (a button's inner label) or a
  // sibling control's (a field's label, which names the field).
  const lifted = node.children.flatMap(simplify);
  const named = new Set(
    [node.name, ...lifted.filter((c) => c.actionable).map((c) => c.name)].filter(Boolean),
  );
  const children = lifted.filter(
    (child) =>
      !(
        roleOf(child) === "text" &&
        !child.children.length &&
        named.has(child.name) &&
        !textOf(child, "text")
      ),
  );
  const quiet = !node.name && !node.actionable && !textOf(node, roleOf(node));
  if (quiet && (WRAPPERS.has(node.role) || roleOf(node) === "text") && !node.unread)
    return children;
  return [{ ...node, children }];
}

/** A table's cells as rows: one line per row, its cells' text in order, the first cell's ref. */
function tableRows(table: DesktopNode): DesktopNode[] {
  const columns = table.columns ?? 0;
  const headers = table.children.filter((c) => /header/.test(roleOf(c)));
  const cells = table.children.filter((c) => !headers.includes(c));
  if (columns < 2 || cells.some((c) => c.children.length) || cells.length % columns)
    return table.children;
  const rows: DesktopNode[] = [];
  if (headers.length)
    rows.push({
      role: "columns",
      name: headers.map((h) => h.name).join(" · "),
      states: new Set(),
      actionable: false,
      children: [],
    });
  for (let i = 0; i < cells.length; i += columns) {
    const row = cells.slice(i, i + columns);
    const states = new Set(row[0]!.states);
    rows.push({
      role: "row",
      name: row.map((c) => c.name || c.text || "").join(" · "),
      states,
      actionable: true,
      ...(row[0]!.ref ? { ref: row[0]!.ref } : {}),
      children: [],
    });
  }
  return rows;
}

function render(nodes: readonly DesktopNode[], depth: number, out: string[], cap: boolean): void {
  const indent = "  ".repeat(depth);
  const shown = cap ? nodes.slice(0, SHOWN_CHILDREN) : nodes;
  for (const node of shown) {
    out.push(`${indent}- ${line(node)}${node.children.length ? ":" : ""}`);
    render(node.columns ? tableRows(node) : node.children, depth + 1, out, cap);
    if (node.unread)
      out.push(`${indent}  - … ${node.unread} more not read (scroll to bring them into view)`);
  }
  if (shown.length < nodes.length)
    out.push(
      `${indent}- … ${nodes.length - shown.length} more like these (desktop_find can locate one)`,
    );
}

function isDialog(window: DesktopWindow): boolean {
  return DIALOGS.has(window.node.role) || window.node.states.has("modal");
}

function windowLines(window: DesktopWindow, cap: boolean): string[] {
  const head = { ...window.node, children: [] };
  const ref = head.ref && !line(head).endsWith(`[${head.ref}]`) ? ` [${head.ref}]` : "";
  const out = [
    `- ${line(head)} (${window.app})${window.node.states.has("active") ? " [active]" : ""}${ref}:`,
  ];
  render(window.node.children.flatMap(simplify), 1, out, cap);
  return out;
}

/** Whether a menu is open: one with items on the screen, which takes the keys and clicks. */
function menuOpen(node: DesktopNode): boolean {
  if (node.role === "menu" && node.children.some((c) => /menu item/.test(c.role))) return true;
  return node.children.some(menuOpen);
}

/** The windows as text: open dialogs first, then the active window, then the rest; paged to `budget` characters. */
export function renderDesktop(
  windows: readonly DesktopWindow[],
  options: { budget?: number; page?: number } = {},
): DesktopSnapshot {
  const budget = options.budget ?? 24_000;
  const dialogs = windows.filter(isDialog);
  const others = windows
    .filter((w) => !isDialog(w))
    .sort((a, b) => Number(b.node.states.has("active")) - Number(a.node.states.has("active")));
  const dialogLines = dialogs.flatMap((w) => windowLines(w, true));
  const bodyLines = others.flatMap((w) => windowLines(w, true));
  const lines = [...dialogs, ...others].flatMap((w) => windowLines(w, false));
  if (!windows.length)
    return {
      text: "No windows are open. Use desktop_launch to start an app.",
      lines,
      pages: 1,
      dialogs: 0,
    };

  const pages = paginate(bodyLines, Math.max(2_000, budget - dialogLines.join("\n").length));
  const page = Math.min(Math.max(1, options.page ?? 1), pages.length);
  const parts: string[] = [];
  if (dialogLines.length)
    parts.push(
      "OPEN DIALOGS (they block their window; handle them first):",
      ...dialogLines,
      "",
      "WINDOWS:",
    );
  if (windows.some((w) => menuOpen(w.node)))
    parts.unshift(
      "A MENU IS OPEN: it takes the keys and clicks until it closes. Pick one of its items, or press Escape to close it.",
      "",
    );
  parts.push(...pages[page - 1]!);
  if (pages.length > 1)
    parts.push(
      page < pages.length
        ? `… page ${page} of ${pages.length}; desktop_observe with page ${page + 1} reads on, desktop_find searches everything.`
        : `(page ${page} of ${pages.length})`,
    );
  return { text: parts.join("\n"), lines, pages: pages.length, dialogs: dialogs.length };
}

function paginate(lines: readonly string[], budget: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > budget && current.length) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(l);
    size += l.length + 1;
  }
  if (current.length || !pages.length) pages.push(current);
  return pages;
}
