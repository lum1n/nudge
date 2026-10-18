// Drives a real GTK app on a desktop of its own: run with NUDGE_DESKTOP_TESTS=1 (needs Xvfb,
// dbus-daemon, at-spi2-core and python-gobject with GTK 3).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, DesktopSession } from "../src/session.ts";

const run = process.env.NUDGE_DESKTOP_TESTS === "1";
const app = new URL("./fixtures/notes.py", import.meta.url).pathname;

/** The ref on the first line of the snapshot that matches. */
function refOf(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const ref = line && /\[(e\d+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`No ref for ${pattern} in:\n${snapshot}`);
  return ref;
}

describe.runIf(run)("a desktop with a GTK app", () => {
  let desktop: DesktopSession;
  let dir: string;
  let saved: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nudge-desktop-test-"));
    saved = join(dir, "saved.txt");
    desktop = await DesktopSession.open({
      homeDir: join(dir, "home"),
      apps: { notes: ["python3", app, saved] },
    });
    expect(await desktop.launch("notes")).toBe("Started notes.");
    await desktop.settle();
  }, 30_000);

  afterAll(async () => {
    await desktop?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the window, with fields named by their labels", async () => {
    const text = await desktop.observe();
    expect(text).toMatch(/^- frame "Notes" \(notes\.py\)/);
    expect(text).toMatch(/textbox "Title" \[e\d+\]/);
    expect(text).toMatch(/combobox "Work" \[e\d+\]/);
    expect(text).toMatch(/checkbox "Pinned" \[e\d+\]/);
    expect(text).not.toContain("menuitem"); // a closed menu isn't on the screen
  });

  it("fills the form, waits for the dialog, and saves", async () => {
    let text = await desktop.observe();
    await desktop.type(refOf(text, /textbox "Title"/), "Trip to Bodø");
    await desktop.type(refOf(text, /textbox "Body"/), "Line one\nLine two");
    await desktop.select(refOf(text, /combobox "Work"/), "Travel");
    await desktop.click(refOf(text, /checkbox "Pinned"/));
    await desktop.click(refOf(text, /button "Save"/));
    await desktop.settle();

    text = await desktop.observe();
    expect(text.startsWith("OPEN DIALOGS")).toBe(true);
    expect(text).toContain('text "Save "Trip to Bodø"?"');
    expect(text).toMatch(/checkbox "Pinned" \[checked\]/);
    expect(text).toMatch(/combobox "Travel"/);
    // The window behind the dialog takes no clicks.
    await expect(desktop.click(refOf(text, /button "Save" /))).rejects.toThrow(
      /behind an open dialog/,
    );

    await desktop.click(refOf(text, /button "Save note"/));
    await desktop.settle();
    expect(readFileSync(saved, "utf8")).toBe(
      "saved title='Trip to Bodø' category='Travel' pinned=True body='Line one\\nLine two'\n",
    );
    text = await desktop.observe();
    expect(text).not.toContain("OPEN DIALOGS");
    expect(text).toContain('text "Saved Trip to Bodø"');
  }, 30_000);

  it("switches tabs and reads the list row by row", async () => {
    let text = await desktop.observe();
    await desktop.click(refOf(text, /tab "Saved"/));
    await desktop.settle();
    text = await desktop.observe();
    expect(text).toMatch(/tab "Saved" \[selected\]/);
    expect(text).toContain('columns "Title · Category"');
    expect(text).toMatch(/row "Trip to Bodø · Travel" \[e\d+\]/);
    expect(await desktop.find("standup")).toMatch(/row "Standup · Work"/);
    await desktop.click(refOf(text, /tab "Write"/));
    await desktop.settle();
  }, 30_000);

  it("presses keys into a field", async () => {
    const text = await desktop.observe();
    const title = refOf(text, /textbox "Title"/);
    await desktop.press("ctrl+a", title);
    await desktop.press("BackSpace", title);
    await desktop.press("shift+x", title);
    await desktop.press("y");
    await desktop.settle();
    expect(await desktop.observe()).toMatch(/textbox "Title" \[focused\] \[e\d+\]: Xy/);
  }, 30_000);

  it("opens a menu and picks an item", async () => {
    let text = await desktop.observe();
    await desktop.click(refOf(text, /menu "File"/));
    await desktop.settle();
    text = await desktop.observe();
    await desktop.click(refOf(text, /menuitem "Clear"/));
    await desktop.settle();
    text = await desktop.observe();
    expect(text).not.toContain("menuitem");
    expect(text).toMatch(/textbox "Title" (\[focused\] )?\[e\d+\]$/m);
  }, 30_000);

  it("says what went wrong, so the agent can try something else", async () => {
    await expect(desktop.launch("calculator")).rejects.toThrow(ActionError);
    await expect(desktop.launch("calculator")).rejects.toThrow(/The apps are: notes/);
    await expect(desktop.click("e9999")).rejects.toThrow(/no element e9999/);
    await expect(desktop.press("hyper+x")).rejects.toThrow(/Unknown modifier/);
    const text = await desktop.observe();
    await expect(desktop.select(refOf(text, /combobox/), "Mars")).rejects.toThrow(
      /no option "Mars"/,
    );
  }, 30_000);
});
