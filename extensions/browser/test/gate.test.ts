import { describe, expect, it } from "vitest";
import { type ActionTarget, type GatedAction, needsApproval } from "../src/gate.ts";
import { runBatch } from "../src/tools.ts";
import { fakeBrowser, target } from "./fake-browser.ts";

const click: GatedAction = { kind: "click" };
const type: GatedAction = { kind: "type", submit: false };
const typeSubmit: GatedAction = { kind: "type", submit: true };
const press = (key: string): GatedAction => ({ kind: "press", key });

const post = { method: "post", hasPassword: false };
const get = { method: "get", hasPassword: false };
const loginForm = { method: "post", hasPassword: true };
const field = (overrides: Partial<ActionTarget> = {}) =>
  target({ tag: "input", type: "text", name: "", ...overrides });

describe("needsApproval", () => {
  it.each<[string, GatedAction, ActionTarget]>([
    ["clicking Pay", click, target({ name: "Pay 1 290 kr" })],
    ["clicking Kjøp nå", click, target({ name: "Kjøp nå" })],
    ["clicking Send on a div button", click, target({ tag: "div", role: "button", name: "Send" })],
    ["clicking Slett on a script link", click, target({ tag: "a", name: "Slett annonse" })],
    [
      "clicking a submit input labelled Bestill",
      click,
      target({ tag: "input", type: "submit", name: "Bestill" }),
    ],
    ["Enter on Place order", press("Enter"), target({ name: "Place order" })],
    ["Space on Delete", press("Space"), target({ name: "Delete" })],
    ["typing a password", type, field({ type: "password" })],
    ["typing a one-time code", type, field({ autocomplete: "one-time-code" })],
    ["typing a card number", type, field({ autocomplete: "cc-number" })],
    [
      "sending a login form by its button",
      click,
      target({ type: "submit", name: "Logg inn", submits: true, form: loginForm }),
    ],
    ["Enter in a login form's field", press("Enter"), field({ form: loginForm })],
    ["typing and submitting into a login form", typeSubmit, field({ form: loginForm })],
    [
      "sending a form while logged in",
      click,
      target({ type: "submit", name: "Save", submits: true, form: post, loggedIn: true }),
    ],
    [
      "Enter in a form field while logged in",
      press("Enter"),
      field({ form: post, loggedIn: true }),
    ],
    [
      "Control+Enter in a form field while logged in",
      press("Control+Enter"),
      field({ form: post, loggedIn: true }),
    ],
    [
      "Enter in a chat box while logged in",
      press("Enter"),
      target({ tag: "div", type: "", editable: true, name: "Message", loggedIn: true }),
    ],
    [
      "Enter in a text area outside a form while logged in",
      press("Enter"),
      target({ tag: "textarea", type: "", loggedIn: true }),
    ],
  ])("asks for %s", (_what, action, t) => {
    expect(needsApproval(action, t)).toBeTypeOf("string");
  });

  it.each<[string, GatedAction, ActionTarget]>([
    ["clicking Search", click, target({ name: "Search" })],
    ["clicking Gå til betaling", click, target({ name: "Gå til betaling" })],
    ["clicking Add to cart", click, target({ name: "Add to cart" })],
    ["clicking Confirm my choices", click, target({ name: "Confirm my choices" })],
    [
      "following a link named Buy",
      click,
      target({ tag: "a", name: "Buy tickets", navigates: true }),
    ],
    ["clicking into a field labelled Send", click, field({ name: "Send to" })],
    ["typing into a search box", type, field({ type: "search", name: "Søk" })],
    ["typing an email", type, field({ type: "email", autocomplete: "email" })],
    ["submitting a search form", typeSubmit, field({ form: get, loggedIn: true })],
    [
      "sending a search form by its button",
      click,
      target({ type: "submit", name: "Go", submits: true, form: get, loggedIn: true }),
    ],
    [
      "sending a POST form while logged out",
      click,
      target({ type: "submit", name: "Go", submits: true, form: post }),
    ],
    ["Enter in a POST form field while logged out", press("Enter"), field({ form: post })],
    [
      "Enter in a text area in a form",
      press("Enter"),
      target({ tag: "textarea", type: "", form: post, loggedIn: true }),
    ],
    [
      "Enter in a chat box while logged out",
      press("Enter"),
      target({ tag: "div", type: "", editable: true }),
    ],
    [
      "Shift+Enter in a chat box",
      press("Shift+Enter"),
      target({ tag: "div", type: "", editable: true, loggedIn: true }),
    ],
    ["Enter on a plain button", press("Enter"), target({ name: "Show more" })],
    ["Escape on Delete", press("Escape"), target({ name: "Delete" })],
    ["ArrowDown in a login form", press("ArrowDown"), field({ form: loginForm })],
    [
      "a button that submits nothing, logged in",
      click,
      target({ name: "Filters", loggedIn: true, form: post }),
    ],
  ])("lets %s through", (_what, action, t) => {
    expect(needsApproval(action, t)).toBeUndefined();
  });
});

describe("the gate in the browser tools", () => {
  const pay = target({ name: "Betal 349 kr" });

  it("refuses a consequential action without the user's approval, and does nothing", async () => {
    const { browser, calls } = fakeBrowser(undefined, { e7: pay });
    const [out] = await runBatch(browser, [
      { id: "a", name: "browser_click", arguments: { ref: "e7" } },
    ]);
    expect(out).toMatchObject({ isError: true });
    expect(out!.text).toMatch(/^Not done: "Betal 349 kr" commits the user.*call browser_confirm/);
    expect(calls).toEqual([]);
  });

  it("lets one through with the approval, and uses it up", async () => {
    const { browser, calls } = fakeBrowser(undefined, { e7: pay, e8: pay });
    const approval = { granted: true };
    const out = await runBatch(
      browser,
      [
        { id: "a", name: "browser_click", arguments: { ref: "e2" } },
        { id: "b", name: "browser_click", arguments: { ref: "e7" } },
        { id: "c", name: "browser_click", arguments: { ref: "e8" } },
      ],
      undefined,
      approval,
    );
    expect(out.map((o) => o.isError)).toEqual([false, false, true]);
    expect(approval.granted).toBe(false);
    expect(calls).toEqual(["click e2", "click e7"]);
  });

  it("checks typing and keys too, on the focused element without a ref", async () => {
    const { browser, calls } = fakeBrowser(undefined, {
      e3: field({ type: "password" }),
      focus: field({ form: loginForm }),
    });
    const out = await runBatch(browser, [
      { id: "a", name: "browser_type", arguments: { ref: "e3", text: "hunter2" } },
    ]);
    expect(out[0]!.text).toMatch(/password/);
    const pressed = await runBatch(browser, [
      { id: "b", name: "browser_press", arguments: { key: "Enter" } },
    ]);
    expect(pressed[0]!.text).toMatch(/login or sign-up form/);
    expect(calls).toEqual([]);
  });
});
