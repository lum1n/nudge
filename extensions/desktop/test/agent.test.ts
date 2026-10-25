import type { ModelContext } from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { describe, expect, it } from "vitest";
import { type DesktopStep, runDesktopAgent } from "../src/agent.ts";
import { progressLine } from "../src/tools.ts";
import { fakeDesktop } from "./fake-desktop.ts";

function setup(steps: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  faux.setResponses(
    steps.map((step) => (request: ModelContext) => {
      requests.push(structuredClone(request));
      return step;
    }),
  );
  return { models, model: faux.getModel(), requests };
}

const text = (request: ModelContext | undefined) => JSON.stringify(request?.messages ?? []);

describe("runDesktopAgent", () => {
  it("acts through the tools until the model answers, ending each turn on the windows", async () => {
    const { models, model, requests } = setup([
      fauxAssistantMessage(
        [
          fauxToolCall("desktop_launch", { app: "notes" }, { id: "a" }),
          fauxToolCall("desktop_click", { ref: "e2" }, { id: "b" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Saved.")]),
    ]);
    const { desktop, calls } = fakeDesktop();
    const steps: DesktopStep[] = [];
    const result = await runDesktopAgent({
      models,
      model,
      desktop,
      task: "Save the note",
      apps: ["notes"],
      onStep: (step) => steps.push(step),
    });
    expect(result).toMatchObject({ outcome: "answered", answer: "Saved.", steps: 2, actions: 2 });
    expect(calls).toEqual(["launch notes", "click e2"]);
    // Only the last call of the batch carries the windows.
    expect(text(requests[1])).toContain('Clicked e2.\\n\\n- frame \\"Notes 2\\"');
    expect(text(requests[1])).not.toContain("Started notes.\\n\\n- frame");
    expect(
      steps.filter((s) => s.type === "doing").map((s) => s.type === "doing" && s.text),
    ).toEqual(["Starting notes…", 'Clicking "Button e2"…']);
    expect(text(requests[0])).toContain("You operate desktop apps on a Linux desktop");
    expect(text(requests[0])).toContain("desktop_launch: notes.");
    expect(text(requests[0])).toContain('"name":"desktop_focus_window"');
  });

  it("stops a batch at the first failure and tells the model", async () => {
    const { models, model, requests } = setup([
      fauxAssistantMessage(
        [
          fauxToolCall("desktop_click", { ref: "e404" }, { id: "a" }),
          fauxToolCall("desktop_type", { ref: "e5", text: "x" }, { id: "b" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Could not do it.")]),
    ]);
    const { desktop, calls } = fakeDesktop();
    const result = await runDesktopAgent({ models, model, desktop, task: "x", apps: [] });
    expect(result).toMatchObject({ outcome: "answered", actions: 2, actionErrors: 2 });
    expect(calls).toEqual(["click e404"]);
    expect(text(requests[1])).toContain("There is no element e404.\\n\\n- frame");
    expect(text(requests[1])).toContain("Not run: an earlier action in this turn failed.");
  });

  it("stops for the user's approval, and once approved does exactly that", async () => {
    const action = 'Click "Delete" to delete the note "Trip"';
    const first = setup([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "desktop_confirm",
            { action, tool: "desktop_click", ref: "e9" },
            { id: "a" },
          ),
          fauxToolCall("desktop_click", { ref: "e9" }, { id: "b" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const fake = fakeDesktop();
    const labels: Record<string, string> = {
      e9: 'button "Delete" [e9]',
      e10: 'button "Send" [e10]',
    };
    const desktop = {
      ...fake.desktop,
      describe: (ref: string) => labels[ref] ?? `button "Button ${ref}" [${ref}]`,
    };
    const calls = fake.calls;
    const stopped = await runDesktopAgent({ ...first, desktop, task: "Delete Trip", apps: [] });
    expect(stopped).toMatchObject({
      outcome: "needs-confirmation",
      action,
      step: { tool: "desktop_click", window: 'frame "Notes"', element: 'button "Delete"' },
    });
    expect(calls).toEqual([]);

    const again = setup([
      // Another button that commits the user is not what was approved.
      fauxAssistantMessage([fauxToolCall("desktop_click", { ref: "e10" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("desktop_click", { ref: "e9" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Deleted.")]),
    ]);
    const done = await runDesktopAgent({
      ...again,
      desktop,
      task: "Delete Trip",
      apps: [],
      approved: action,
      approvedStep: stopped.step!,
    });
    expect(done).toMatchObject({ outcome: "answered", answer: "Deleted.", actionErrors: 1 });
    expect(text(again.requests[0])).toContain(`they approved it: ${action.replaceAll('"', '\\"')}`);
    expect(text(again.requests[1])).toContain("approved a different action");
    expect(calls).toEqual(["click e9"]);
  });

  it("drops older views of the windows from later requests", async () => {
    const { models, model, requests } = setup([
      fauxAssistantMessage([fauxToolCall("desktop_click", { ref: "e2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("desktop_click", { ref: "e2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const long = (n: number) =>
      `- frame "Notes ${n}" (notes) [e1]:\n${'  - text "line"\n'.repeat(40)}`;
    const { desktop } = fakeDesktop(long);
    await runDesktopAgent({ models, model, desktop, task: "x", apps: [] });
    expect(text(requests[2])).toContain("Clicked e2.\\n(older view omitted)");
    expect(text(requests[2])).toContain('- frame \\"Notes 2\\"');
  });

  it("gives up after its most steps", async () => {
    const { models, model } = setup(
      Array.from({ length: 3 }, () =>
        fauxAssistantMessage([fauxToolCall("desktop_observe", {})], { stopReason: "toolUse" }),
      ),
    );
    const { desktop } = fakeDesktop();
    const result = await runDesktopAgent({
      models,
      model,
      desktop,
      task: "x",
      apps: [],
      maxSteps: 3,
    });
    expect(result).toMatchObject({ outcome: "max-steps", steps: 3 });
  });
});

describe("progressLine", () => {
  it("names the element from the last observation, and never shows typed text", () => {
    const desktop = { describe: (ref: string) => (ref === "e3" ? 'textbox "Title" [e3]' : ref) };
    expect(
      progressLine(desktop, { name: "desktop_type", arguments: { ref: "e3", text: "secret" } }),
    ).toBe('Typing into "Title"…');
    expect(progressLine(desktop, { name: "desktop_click", arguments: { ref: "e8" } })).toBe(
      "Clicking an element…",
    );
    expect(progressLine(desktop, { name: "desktop_press", arguments: { keys: "ctrl+s" } })).toBe(
      "Pressing ctrl+s…",
    );
  });
});
