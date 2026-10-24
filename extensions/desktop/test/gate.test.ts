import { describe, expect, it } from "vitest";
import { consequentialControl, runBatch } from "../src/tools.ts";
import { fakeDesktop } from "./fake-desktop.ts";

describe("consequentialControl", () => {
  it.each([
    'button "Send" [e4]',
    'button "Delete" [e4]',
    'button "Pay now" [e4]',
    'menuitem "Publish" [e4]',
    'toggle button "Send" [e4]',
    'link "Unsubscribe" [e4]',
    'button "Slett melding" [e4]',
  ])("holds %s", (line) => {
    expect(consequentialControl(line)).toMatch(/commits the user/);
  });

  it.each([
    'button "Save" [e4]',
    'button "Search" [e4]',
    'menuitem "Sending options" [e4]',
    'listitem "Send invoice.pdf" [e4]',
    'textbox "Send to" [e4]',
    'tab "Delete" [e4]',
    "button [e4]",
    "e4",
  ])("lets %s through", (line) => {
    expect(consequentialControl(line)).toBeUndefined();
  });
});

describe("the gate in the desktop tools", () => {
  function setup(labels: Record<string, string>) {
    const { desktop, calls } = fakeDesktop();
    const gated = {
      ...desktop,
      describe: (ref: string) => labels[ref] ?? `button "Button ${ref}" [${ref}]`,
    };
    return { desktop: gated, calls };
  }

  it("refuses a consequential click without the user's approval, and does nothing", async () => {
    const { desktop, calls } = setup({ e5: 'button "Send" [e5]' });
    const [out] = await runBatch(desktop, [
      { id: "a", name: "desktop_click", arguments: { ref: "e5" } },
    ]);
    expect(out!.text).toMatch(/^Not done: "Send" commits the user.*desktop_confirm/);
    expect(calls).toEqual([]);
  });

  it("lets one through with the approval, and uses it up", async () => {
    const { desktop, calls } = setup({ e5: 'button "Send" [e5]', e6: 'button "Delete" [e6]' });
    const approval = { granted: true };
    const out = await runBatch(
      desktop,
      [
        { id: "a", name: "desktop_click", arguments: { ref: "e2" } },
        { id: "b", name: "desktop_click", arguments: { ref: "e5" } },
        { id: "c", name: "desktop_click", arguments: { ref: "e6" } },
      ],
      undefined,
      approval,
    );
    expect(out.map((o) => o.isError)).toEqual([false, false, true]);
    expect(approval.granted).toBe(false);
    expect(calls).toEqual(["click e2", "click e5"]);
  });

  it("holds Enter on such a button, and Control+Enter anywhere", async () => {
    const { desktop } = setup({ e5: 'button "Send" [e5]' });
    for (const args of [{ keys: "Enter", ref: "e5" }, { keys: "ctrl+Return" }]) {
      const [out] = await runBatch(desktop, [{ id: "a", name: "desktop_press", arguments: args }]);
      expect(out!.text).toMatch(/^Not done/);
    }
    const [plain] = await runBatch(desktop, [
      { id: "a", name: "desktop_press", arguments: { keys: "Enter", ref: "e2" } },
    ]);
    expect(plain!.isError).toBe(false);
  });
});
