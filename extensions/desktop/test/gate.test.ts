import { describe, expect, it } from "vitest";
import type { Approval, Surroundings } from "../src/session.ts";
import {
  consequentialControl,
  type Desktop,
  overwriteReason,
  runBatch,
  submitReason,
} from "../src/tools.ts";
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

const around = (overrides: Partial<Surroundings> = {}): Surroundings => ({
  element: 'button "OK"',
  multiLine: false,
  window: 'frame "Notes"',
  text: "",
  ...overrides,
});

describe("overwriteReason", () => {
  const replacing = {
    window: 'dialog "Replace file?"',
    text: 'text "A file named “notes.txt” already exists. Do you want to replace it?"',
  };

  it.each<[string, Surroundings]>([
    [
      "Replace in a dialog asking to replace a file",
      around({ ...replacing, element: 'button "Replace"' }),
    ],
    ["Yes in Qt's overwrite question", around({ ...replacing, element: 'button "Yes"' })],
    [
      "Erstatt in a Norwegian one",
      around({ text: 'text "Filen finnes allerede."', element: 'button "Erstatt"' }),
    ],
    [
      "Save in a window with a file open",
      around({ window: 'frame "notes.txt - gedit"', element: 'button "Save"' }),
    ],
    [
      "the Save menu item in LibreOffice",
      around({ window: 'frame "Rapport.odt - LibreOffice Writer"', element: 'menuitem "Save"' }),
    ],
  ])("holds %s", (_what, place) => {
    expect(overwriteReason(place)).toBeTypeOf("string");
  });

  it.each<[string, Surroundings]>([
    [
      "Cancel in a dialog asking to replace a file",
      around({ ...replacing, element: 'button "Cancel"' }),
    ],
    [
      "Save in an untitled document",
      around({ window: 'frame "Untitled 1 - LibreOffice Writer"', element: 'button "Save"' }),
    ],
    ["Save in an app without a file in its title", around({ element: 'button "Save"' })],
    [
      "Save As in a window with a file open",
      around({ window: 'frame "notes.txt - gedit"', element: 'menuitem "Save As…"' }),
    ],
    [
      "Save in a window named by a version",
      around({ window: 'frame "Editor 7.6"', element: 'button "Save"' }),
    ],
    [
      "Save in a mail window named by an address",
      around({ window: 'frame "Inbox - kari@example.no"', element: 'button "Save"' }),
    ],
    [
      "a field in a dialog about a file that exists",
      around({ ...replacing, element: 'textbox "Name"' }),
    ],
  ])("lets %s through", (_what, place) => {
    expect(overwriteReason(place)).toBeUndefined();
  });
});

describe("submitReason", () => {
  it.each(['textbox "Message"', 'textbox "Skriv en melding"', "textbox", ""])(
    "holds Enter in %s",
    (element) => {
      expect(submitReason(around({ element }))).toMatch(/may send/);
    },
  );

  it.each([
    'textbox "Search"',
    'textbox "Søk i e-post"',
    'textbox "Name"',
    'combobox "Location"',
    'textbox "Find"',
  ])("lets Enter in %s through", (element) => {
    expect(submitReason(around({ element }))).toBeUndefined();
  });
});

describe("the gate in the desktop tools", () => {
  function setup(
    labels: Record<string, string>,
    places: Record<string, Partial<Surroundings>> = {},
    deletes = false,
  ) {
    const { desktop, calls } = fakeDesktop();
    const gated: Desktop = {
      ...desktop,
      describe: (ref: string) => labels[ref] ?? `button "Button ${ref}" [${ref}]`,
      around: (ref?: string) => {
        const key = ref ?? "focus";
        const element =
          ref === undefined ? 'textbox "Title"' : gated.describe(ref).replace(/ \[.*$/, "");
        return around({ element, ...places[key] });
      },
      deletes: async () => deletes,
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

  it("lets the approved action through once, and nothing else", async () => {
    const { desktop, calls } = setup({
      e5: 'button "Send" [e5]',
      e6: 'button "Delete" [e6]',
      e7: 'button "Send" [e7]',
    });
    const approval: Approval = {
      approved: { tool: "desktop_click", window: 'frame "Notes"', element: 'button "Send"' },
    };
    const out = await runBatch(
      desktop,
      [
        { id: "a", name: "desktop_click", arguments: { ref: "e2" } },
        { id: "b", name: "desktop_click", arguments: { ref: "e6" } },
      ],
      undefined,
      approval,
    );
    expect(out.map((o) => o.isError)).toEqual([false, true]);
    expect(out[1]!.text).toMatch(/approved a different action/);
    expect(approval.approved).toBeDefined();
    const sent = await runBatch(
      desktop,
      [
        { id: "c", name: "desktop_click", arguments: { ref: "e5" } },
        { id: "d", name: "desktop_click", arguments: { ref: "e7" } },
      ],
      undefined,
      approval,
    );
    expect(sent.map((o) => o.isError)).toEqual([false, true]);
    expect(approval.approved).toBeUndefined();
    expect(calls).toEqual(["click e2", "click e5"]);
  });

  it("pins what desktop_confirm asks for, by tool, keys, element and window", async () => {
    const { desktop, calls } = setup(
      { e5: 'button "Send" [e5]' },
      { e5: { window: 'frame "Reply - Thunderbird"' } },
    );
    const approval: Approval = {};
    await runBatch(
      desktop,
      [
        {
          id: "a",
          name: "desktop_confirm",
          arguments: { action: "Send the reply", tool: "desktop_press", keys: "Ctrl + Return" },
        },
      ],
      undefined,
      approval,
    );
    expect(approval.asked).toEqual({
      tool: "desktop_press",
      keys: "ctrl+return",
      window: 'frame "Notes"',
      element: 'textbox "Title"',
    });
    // Approved: Control+Enter into the same field goes; clicking Send doesn't.
    const next: Approval = { approved: approval.asked! };
    const [click] = await runBatch(
      desktop,
      [{ id: "b", name: "desktop_click", arguments: { ref: "e5" } }],
      undefined,
      next,
    );
    expect(click!.isError).toBe(true);
    const [press] = await runBatch(
      desktop,
      [{ id: "c", name: "desktop_press", arguments: { keys: "ctrl+Return" } }],
      undefined,
      next,
    );
    expect(press!.isError).toBe(false);
    expect(calls).toEqual(["press ctrl+Return"]);
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

  it("holds typing with Enter into a field that may send it, but not a search box", async () => {
    const { desktop, calls } = setup(
      {
        e3: 'textbox "Message" [e3]',
        e4: 'textbox "Search" [e4]',
        e8: 'textbox "Body" [e8]',
      },
      { e8: { multiLine: true } },
    );
    const [sent] = await runBatch(desktop, [
      { id: "a", name: "desktop_type", arguments: { ref: "e3", text: "Hi", submit: true } },
    ]);
    expect(sent!.text).toMatch(/^Not done: Enter in this field may send/);
    const out = await runBatch(desktop, [
      { id: "b", name: "desktop_type", arguments: { ref: "e3", text: "Hi" } },
      { id: "c", name: "desktop_type", arguments: { ref: "e4", text: "Kari", submit: true } },
      // Enter in a multi-line field is a new line.
      { id: "d", name: "desktop_press", arguments: { keys: "Return", ref: "e8" } },
    ]);
    expect(out.map((o) => o.isError)).toEqual([false, false, false]);
    expect(calls).toEqual(["type e3 Hi", "type e4 Kari", "press Return e8"]);
    // Enter by itself into the focused one-line field is the same as submitting.
    const [enter] = await runBatch(desktop, [
      { id: "e", name: "desktop_press", arguments: { keys: "Enter" } },
    ]);
    expect(enter!.text).toMatch(/^Not done: Enter in this field may send/);
  });

  it("holds saving over a file that exists, by key, by Save, and in the replace dialog", async () => {
    const file = { window: 'frame "notes.txt - gedit"' };
    const { desktop, calls } = setup(
      {
        e2: 'button "Save" [e2]',
        e3: 'button "Replace" [e3]',
        e4: 'button "Cancel" [e4]',
        e5: 'textbox "Body" [e5]',
      },
      {
        focus: file,
        e2: file,
        e5: { window: 'frame "Untitled Document 1 - gedit"' },
        e3: { window: 'alert "Replace?"', text: 'text "A file named “a.txt” already exists."' },
        e4: { window: 'alert "Replace?"', text: 'text "A file named “a.txt” already exists."' },
      },
    );
    for (const args of [{ keys: "ctrl+s" }]) {
      const [out] = await runBatch(desktop, [{ id: "a", name: "desktop_press", arguments: args }]);
      expect(out!.text).toMatch(/^Not done: saving writes over "notes.txt"/);
    }
    for (const ref of ["e2", "e3"]) {
      const [out] = await runBatch(desktop, [
        { id: "a", name: "desktop_click", arguments: { ref } },
      ]);
      expect(out!.text, ref).toMatch(/^Not done/);
    }
    const out = await runBatch(desktop, [
      { id: "a", name: "desktop_click", arguments: { ref: "e4" } },
      { id: "b", name: "desktop_press", arguments: { keys: "ctrl+s", ref: "e5" } },
    ]);
    expect(out.map((o) => o.isError)).toEqual([false, false]);
    expect(calls).toEqual(["click e4", "press ctrl+s e5"]);
  });

  it("holds ctrl+s when it isn't known which window gets it", async () => {
    const { desktop } = setup({});
    const unknown: Desktop = { ...desktop, around: () => undefined };
    const [out] = await runBatch(unknown, [
      { id: "a", name: "desktop_press", arguments: { keys: "ctrl+s" } },
    ]);
    expect(out!.text).toMatch(/^Not done: ctrl\+s may save over a file/);
  });

  it("holds Delete where it deletes items", async () => {
    const { desktop, calls } = setup({ e9: 'row "Standup · Work" [e9]' }, {}, true);
    const [out] = await runBatch(desktop, [
      { id: "a", name: "desktop_press", arguments: { keys: "Delete", ref: "e9" } },
    ]);
    expect(out!.text).toMatch(/^Not done: Delete here deletes what is selected/);
    expect(calls).toEqual([]);
  });
});
