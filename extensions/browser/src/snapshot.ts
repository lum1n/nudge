/** One node of Playwright's `ariaSnapshot({ mode: "ai" })` tree. */
export interface AriaNode {
  role: string;
  name?: string;
  ref?: string;
  box?: [number, number, number, number];
  attrs: Record<string, string | true>;
  props: Record<string, string>;
  text?: string;
  children: AriaNode[];
}

export interface Viewport {
  scrollY: number;
  height: number;
}

export interface CompactOptions {
  /** Character budget for the rendered page; dialogs always fit first. */
  budget?: number;
  /** 1-based page of the rendered lines when the page is over budget. */
  page?: number;
  viewport?: Viewport;
}

export interface CompactSnapshot {
  text: string;
  /** Every rendered line, unbudgeted and uncollapsed, for `find`. */
  lines: string[];
  pages: number;
  dialogs: number;
}

const INTERACTIVE = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
]);
const WRAPPERS = new Set(["generic", "none", "presentation", "group", "region", "section"]);
const DIALOGS = new Set(["dialog", "alertdialog"]);
const ITEMS = new Set(["article", "listitem", "row"]);
const FORM_CONTROLS = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "spinbutton",
  "slider",
  "switch",
  "listbox",
]);
const KEPT_ATTRS = [
  "checked",
  "disabled",
  "expanded",
  "selected",
  "pressed",
  "required",
  "invalid",
  "level",
];

export function parseAriaSnapshot(raw: string): AriaNode {
  const root: AriaNode = { role: "root", attrs: {}, props: {}, children: [] };
  const stack: { indent: number; node: AriaNode }[] = [{ indent: -1, node: root }];
  for (const line of raw.split("\n")) {
    const match = /^(\s*)- (.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    const body = unquote(match[2]!);
    const prop = /^\/([a-z]+): ?(.*)$/.exec(body);
    if (prop) {
      parent.props[prop[1]!] = unquote(prop[2]!);
      continue;
    }
    const node = parseNode(body);
    parent.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

function parseNode(body: string): AriaNode {
  const node: AriaNode = { role: "", attrs: {}, props: {}, children: [] };
  let rest = body;
  const role = /^[a-z][a-zA-Z]*/.exec(rest);
  node.role = role ? role[0] : "text";
  rest = rest.slice(role ? role[0].length : 0);
  const name = /^ "((?:[^"\\]|\\.)*)"/.exec(rest);
  if (name) {
    node.name = name[1]!.replace(/\\(.)/g, "$1");
    rest = rest.slice(name[0].length);
  }
  for (
    let attr = /^ \[([a-z-]+)(?:=([^\]]*))?\]/.exec(rest);
    attr;
    attr = /^ \[([a-z-]+)(?:=([^\]]*))?\]/.exec(rest)
  ) {
    const [whole, key, value] = attr;
    if (key === "ref") node.ref = value;
    else if (key === "box") {
      const parts = (value ?? "").split(",").map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite))
        node.box = parts as [number, number, number, number];
    } else node.attrs[key!] = value ?? true;
    rest = rest.slice(whole.length);
  }
  const text = /^: ?(.*)$/.exec(rest);
  if (text && text[1]) node.text = unquote(text[1]);
  return node;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
    return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function isClickable(node: AriaNode): boolean {
  return INTERACTIVE.has(node.role) || node.attrs.cursor === "pointer";
}

/** Text a node contributes on its own, without children. */
function ownText(node: AriaNode): string[] {
  const out: string[] = [];
  if (node.name) out.push(node.name);
  if (node.text && node.text !== node.name) out.push(node.text);
  return out;
}

/** Drop images and anonymous wrappers, lift a lone image's alt text into an unnamed control. */
function simplify(node: AriaNode): AriaNode[] {
  const children = node.children.flatMap(simplify);
  if (node.role === "img") return [];
  if (!node.name && isClickable(node)) {
    const img = firstImageName(node);
    if (img) node.name = img;
  }
  node.children = children;
  const anonymous = !node.name && !node.text && !isClickable(node) && !node.props.url;
  if (WRAPPERS.has(node.role) && anonymous) return children;
  if (node.role === "generic" && !isClickable(node) && !node.children.length && node.text) {
    return [{ ...node, role: "text", ref: undefined }];
  }
  return [node];
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function allText(node: AriaNode): string {
  return [...ownText(node), ...node.children.map(allText)].join(" ");
}

/** Drop empty leaves, and text or labels that only repeat a sibling control's or the parent's name. */
function dedupe(nodes: AriaNode[], parentName: string | undefined): AriaNode[] {
  const names = nodes.flatMap(controlNames).map(norm);
  if (parentName) names.push(norm(parentName));
  const seen = new Set<string>();
  return nodes.filter((node) => {
    node.children = dedupe(node.children, node.name);
    const empty =
      !node.name &&
      !node.text &&
      !node.children.length &&
      !node.props.url &&
      !INTERACTIVE.has(node.role);
    if (empty && node.role !== "separator") return false;
    if (INTERACTIVE.has(node.role) || hasInteractive(node)) return true;
    const text = norm(allText(node));
    if (!text) return !empty;
    if (
      names.some(
        (name) => name && (name === text || name.startsWith(text) || text.startsWith(name)),
      )
    )
      return false;
    if (node.role === "text" && seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function controlNames(node: AriaNode): string[] {
  const own = node.name && INTERACTIVE.has(node.role) ? [node.name] : [];
  return [...own, ...node.children.flatMap(controlNames)];
}

function hasInteractive(node: AriaNode): boolean {
  return node.children.some((c) => INTERACTIVE.has(c.role) || hasInteractive(c));
}

function firstImageName(node: AriaNode): string | undefined {
  for (const child of node.children) {
    if (child.role === "img" && child.name) return child.name;
    const nested = child.role === "img" ? undefined : firstImageName(child);
    if (nested) return nested;
  }
  return undefined;
}

function nodeLine(node: AriaNode): string {
  let line = node.role === "text" ? "text" : node.role;
  if (node.name) line += ` "${node.name}"`;
  for (const key of KEPT_ATTRS) {
    const value = node.attrs[key];
    if (value === true) line += ` [${key}]`;
    else if (value !== undefined) line += ` [${key}=${value}]`;
  }
  if (node.ref && isClickable(node)) line += ` [${node.ref}]`;
  if (node.props.url) line += ` → ${node.props.url}`;
  if (node.props.placeholder) line += ` (placeholder: ${node.props.placeholder})`;
  if (node.text) line += `: ${node.text}`;
  return line;
}

/** Normalized line for spotting runs of near-identical siblings (carousel dots, numbered pages). */
function shape(line: string): string {
  return line.replace(/\[e\d+\]|\[f\d+e\d+\]/g, "").replace(/\d+/g, "#");
}

function hasFormControl(node: AriaNode): boolean {
  return node.children.some((c) => FORM_CONTROLS.has(c.role) || hasFormControl(c));
}

/** An item becomes one row unless it holds form controls the model may need to reach. */
function isRowItem(node: AriaNode): boolean {
  return ITEMS.has(node.role) && !hasFormControl(node);
}

function isItemList(node: AriaNode): boolean {
  const items = node.children.filter(isRowItem);
  return items.length >= 3 && items.length >= node.children.length / 2;
}

function textCount(node: AriaNode): number {
  return ownText(node).length + node.children.reduce((sum, c) => sum + textCount(c), 0);
}

/** A button that wraps a heading, a list or several texts is the item itself, not a side control. */
function isCard(node: AriaNode): boolean {
  if (node.role !== "button") return false;
  const structured = (n: AriaNode): boolean =>
    n.children.some((c) => c.role === "heading" || c.role === "list" || structured(c));
  return structured(node) || textCount(node) >= 4;
}

/** One line per item: its texts in order, then the ref to open it (a link, or a card button). */
function itemRow(node: AriaNode): string {
  const texts: string[] = [];
  let link: AriaNode | undefined;
  let card: AriaNode | undefined;
  const walk = (n: AriaNode, inControl: boolean) => {
    if (!link && n.role === "link" && n.ref) link = n;
    if (!card && !inControl && isCard(n)) card = n;
    const control = inControl || (n.role === "button" && n !== card);
    const container = WRAPPERS.has(n.role) && n.children.length > 0;
    if (!control && !container) for (const t of ownText(n)) if (!texts.includes(t)) texts.push(t);
    for (const c of n.children) walk(c, control);
  };
  walk(node, false);
  const target = link ?? card ?? (isClickable(node) ? node : undefined);
  let line = texts.join(" · ");
  if (line.length > 300) line = `${line.slice(0, 297)}…`;
  if (target?.ref) line += ` [${target.ref}]`;
  if (link?.props.url) line += ` → ${link.props.url}`;
  return `item: ${line}`;
}

const COLLAPSIBLE = new Set(["button", "text", "generic", "listitem", "paragraph"]);

function render(nodes: AriaNode[], depth: number, out: string[], collapse: boolean): void {
  const indent = "  ".repeat(depth);
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i]!;
    const line = nodeLine(node);
    let run = i + 1;
    while (
      run < nodes.length &&
      !nodes[run]!.children.length &&
      shape(nodeLine(nodes[run]!)) === shape(line)
    )
      run++;
    if (
      collapse &&
      COLLAPSIBLE.has(node.role) &&
      !node.props.url &&
      !node.children.length &&
      run - i > 2
    ) {
      out.push(
        `${indent}- ${line}`,
        `${indent}- … ${run - i - 1} more like this (browser_find can locate one)`,
      );
      i = run;
      continue;
    }
    out.push(`${indent}- ${line}${node.children.length ? ":" : ""}`);
    if (isItemList(node)) {
      for (const child of node.children) {
        if (isRowItem(child)) out.push(`${indent}  - ${itemRow(child)}`);
        else render([child], depth + 1, out, collapse);
      }
    } else render(node.children, depth + 1, out, collapse);
    i++;
  }
}

function extractDialogs(nodes: AriaNode[], found: AriaNode[]): AriaNode[] {
  return nodes.flatMap((node) => {
    if (DIALOGS.has(node.role) || node.attrs.modal === "true") {
      if (node.children.length || node.name) found.push(node);
      return [];
    }
    node.children = extractDialogs(node.children, found);
    return [node];
  });
}

/** Lines that start a new page break at a top-level-ish boundary, never inside a row. */
function paginate(lines: string[], budget: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > budget && current.length) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length || !pages.length) pages.push(current);
  return pages;
}

export function compactSnapshot(raw: string, options: CompactOptions = {}): CompactSnapshot {
  const budget = options.budget ?? 24_000;
  const root = parseAriaSnapshot(raw);
  const nodes = dedupe(root.children.flatMap(simplify), undefined);
  const dialogs: AriaNode[] = [];
  const body = extractDialogs(nodes, dialogs);

  const dialogLines: string[] = [];
  render(dialogs, 0, dialogLines, true);
  const bodyLines: string[] = [];
  render(body, 0, bodyLines, true);
  const fullLines: string[] = [];
  render([...dialogs, ...body], 0, fullLines, false);

  const pages = paginate(bodyLines, Math.max(2_000, budget - dialogLines.join("\n").length));
  const pageNumber = Math.min(Math.max(1, options.page ?? 1), pages.length);
  const parts: string[] = [];
  if (dialogLines.length) {
    parts.push(
      "OPEN DIALOGS (they cover the page; handle them first):",
      ...dialogLines,
      "",
      "PAGE (behind the dialogs):",
    );
  }
  parts.push(...pages[pageNumber - 1]!);
  if (pages.length > 1) {
    parts.push(
      pageNumber < pages.length
        ? `… page ${pageNumber} of ${pages.length}; browser_observe with page ${pageNumber + 1} reads on, browser_find searches the whole page.`
        : `(page ${pageNumber} of ${pages.length})`,
    );
  }
  return {
    text: parts.join("\n"),
    lines: fullLines,
    pages: pages.length,
    dialogs: dialogs.length,
  };
}

/** Lines matching every word of the query, case-insensitively. */
export function findLines(lines: readonly string[], query: string, limit = 40): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = lines.filter((line) => {
    const lower = line.toLowerCase();
    return words.every((w) => lower.includes(w));
  });
  const shown = hits.slice(0, limit).map((line) => line.trim());
  if (hits.length > limit) shown.push(`… ${hits.length - limit} more matches; narrow the query.`);
  return shown;
}
