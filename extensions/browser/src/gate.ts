import { consequentialLabel } from "@nudge/core";

/** The user's approval of one consequential action, from browser_confirm; used up when taken. */
export interface Approval {
  granted: boolean;
}

/** What an action is about to touch, read from the page just before it (`BrowserSession.inspect`). */
export interface ActionTarget {
  /** Lowercase tag name, like `button` or `input`. */
  tag: string;
  /** An input's or button's own type, lowercase; empty for other elements. */
  type: string;
  /** The `role` attribute, lowercase. */
  role: string;
  /** What the element says: its ARIA label, text, a button input's value, or its title. */
  name: string;
  autocomplete: string;
  /** `contenteditable`, like most chat and comment boxes. */
  editable: boolean;
  /** A link to another page: clicking it only goes there, like browser_navigate. */
  navigates: boolean;
  /** A button that submits the form it belongs to. */
  submits: boolean;
  /** The form the element is in or submits: its method (`get`, `post`, `dialog`), and whether it asks for a password. */
  form?: { method: string; hasPassword: boolean };
  /** The page has a way to log out, so the user is logged in on it. */
  loggedIn: boolean;
}

export type GatedAction =
  | { kind: "click" }
  | { kind: "type"; submit: boolean }
  | { kind: "press"; key: string };

/** Enter, alone or with Control or Meta as chat apps send with; Shift+Enter is a new line. */
const ENTER = /^(?:(?:control|ctrl|meta|cmd|command)\+)?(?:enter|numpadenter|return)$/i;
const SPACE = /^(?:space| )$/i;
const SECRET_AUTOCOMPLETE = /\b(?:current-password|new-password|one-time-code|cc-number|cc-csc)\b/;
/** Inputs that take no typed text. */
const NOT_TEXT = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "checkbox",
  "radio",
  "file",
  "color",
  "range",
  "hidden",
]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/**
 * Why an action needs the user's approval, or undefined when it doesn't. The browser agent is
 * told to call browser_confirm first; this holds it to that in code, whatever a page made the
 * model believe. It asks for:
 * - a control whose label commits the user (`consequentialLabel`: "Pay", "Send", "Slett"…),
 *   clicked, or activated with Enter or Space; links to other pages are only navigation;
 * - typing into a password, one-time-code or card field;
 * - submitting a form that is not a search (`method="post"`) when it asks for a password, or
 *   when the user is logged in on the site, by its button or by Enter in one of its fields;
 * - Enter in a text box outside a form, like a chat box, when the user is logged in.
 */
export function needsApproval(action: GatedAction, target: ActionTarget): string | undefined {
  const field = isTextField(target);
  switch (action.kind) {
    case "type":
      if (isSecret(target))
        return "this field takes a password, one-time code or card number, which the user enters themselves or approves";
      return action.submit ? onEnter(target) : undefined;
    case "press":
      if (ENTER.test(action.key.trim())) return field ? onEnter(target) : onActivate(target);
      if (SPACE.test(action.key) && !field) return onActivate(target);
      return undefined;
    case "click":
      // Clicking a field only puts the cursor in it.
      return field ? undefined : onActivate(target);
  }
}

function isTextField(t: ActionTarget): boolean {
  if (t.tag === "input") return !NOT_TEXT.has(t.type);
  return t.tag === "textarea" || t.editable || TEXT_ROLES.has(t.role);
}

function isSecret(t: ActionTarget): boolean {
  return t.tag === "input" && (t.type === "password" || SECRET_AUTOCOMPLETE.test(t.autocomplete));
}

/** Clicking a control, or Enter or Space on it. */
function onActivate(t: ActionTarget): string | undefined {
  if (!t.navigates) {
    const word = consequentialLabel(t.name);
    if (word !== undefined) return `"${t.name}" commits the user to something ("${word}")`;
  }
  return t.submits ? sending(t) : undefined;
}

/** Enter in a text field submits its form; a text area takes it as a new line. */
function onEnter(t: ActionTarget): string | undefined {
  if (t.form && t.tag !== "textarea") return sending(t);
  if (!t.form && (t.editable || t.tag === "textarea") && t.loggedIn)
    return "Enter here may send what was typed, on a site the user is logged in to";
  return undefined;
}

/** Whether submitting the target's form commits the user: searches and filters use GET. */
function sending(t: ActionTarget): string | undefined {
  if (!t.form || t.form.method === "get" || t.form.method === "dialog") return undefined;
  if (t.form.hasPassword) return "it sends a login or sign-up form";
  if (t.loggedIn) return "it sends a form on a site the user is logged in to";
  return undefined;
}

/** A page's element, as far as `inspectTarget` reads it; this package compiles without the DOM lib. */
export interface PageElement {
  nodeType: number;
  tagName: string;
  type?: string;
  value?: string;
  method?: string;
  formMethod?: string;
  isContentEditable?: boolean;
  innerText?: string;
  textContent: string | null;
  form?: PageElement | null;
  ownerDocument: {
    getElementById(id: string): PageElement | null;
    querySelectorAll(selector: string): ArrayLike<PageElement>;
  };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): PageElement | null;
  querySelector(selector: string): PageElement | null;
}

/**
 * Runs in the page with the element an action is about to touch, and reads what `needsApproval`
 * needs. Playwright sends it as source, so it uses nothing from outside itself.
 */
export function inspectTarget(given: PageElement | null): ActionTarget | null {
  if (!given || given.nodeType !== 1) return null;
  // Text or an icon inside a button is the button.
  const el = given.closest("button, a, [role=button], [role=link], [role=menuitem]") ?? given;
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const tag = el.tagName.toLowerCase();
  const type = tag === "input" || tag === "button" ? (el.type ?? "").toLowerCase() : "";
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  const doc = el.ownerDocument;
  const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? doc.getElementById(id)?.textContent : ""))
    .join(" ");
  const buttonValue =
    tag === "input" && ["submit", "button", "reset"].includes(type) ? el.value : "";
  const field = tag === "input" || tag === "textarea" || Boolean(el.isContentEditable);
  const name =
    clean(el.getAttribute("aria-label")) ||
    clean(labelledBy) ||
    (field ? "" : clean(el.innerText ?? el.textContent)) ||
    clean(buttonValue) ||
    clean(el.getAttribute("title")) ||
    clean(el.getAttribute("alt")) ||
    (field ? clean(el.getAttribute("placeholder")) : "");
  const href = tag === "a" ? (el.getAttribute("href") ?? "").trim() : "";
  const navigates =
    tag === "a" && href !== "" && !/^(#|javascript:)/i.test(href) && role !== "button";
  const form = el.form ?? el.closest("form");
  const submits =
    form !== null &&
    ((tag === "button" && type === "submit") ||
      (tag === "input" && (type === "submit" || type === "image")));
  let method = (form?.method || "get").toLowerCase();
  if (submits && el.hasAttribute("formmethod")) method = (el.formMethod || method).toLowerCase();
  // A way to log out anywhere on the page, menus included, means someone is logged in.
  const out = /(^|[^a-z])(log\s?out|log\s?off|sign\s?out|logg\s?ut)([^a-z]|$)/i;
  const outHref = /log-?out|log-?off|sign-?out|logg-?ut/i;
  const loggedIn = Array.from(
    doc.querySelectorAll("a, button, [role=button], [role=menuitem], input[type=submit]"),
  )
    .slice(0, 5_000)
    .some(
      (c) =>
        out.test(c.getAttribute("aria-label") ?? "") ||
        out.test(clean(c.textContent).slice(0, 40)) ||
        out.test(c.value ?? "") ||
        outHref.test(c.getAttribute("href") ?? ""),
    );
  return {
    tag,
    type,
    role,
    name: name.slice(0, 200),
    autocomplete: (el.getAttribute("autocomplete") ?? "").toLowerCase(),
    editable: Boolean(el.isContentEditable),
    navigates,
    submits,
    ...(form
      ? { form: { method, hasPassword: form.querySelector("input[type=password]") !== null } }
      : {}),
    loggedIn,
  };
}
