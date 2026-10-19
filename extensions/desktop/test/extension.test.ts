import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import desktop from "../src/extension.ts";
import { fakeDesktop } from "./fake-desktop.ts";

const context = BACKGROUND_CONTEXT;
const EMAIL = "kari.nordmann@example.no";

const fake = fakeDesktop(
  (n) =>
    `- frame "Mail ${n}" (mail) [active] [e1]:\n  - text "From: ${EMAIL}"\n  - button "Reply" [e9]`,
);
const opened: { homeDir: string; apps: Readonly<Record<string, readonly string[]>> }[] = [];
vi.mock("../src/pool.ts", () => ({
  withDesktop: (
    options: { homeDir: string; apps: Readonly<Record<string, readonly string[]>> },
    _idleMs: number,
    use: (d: unknown) => unknown,
  ) => {
    opened.push(options);
    return use(fake.desktop);
  },
  closeAllDesktops: async () => {},
}));
// Tests run where Xvfb may be missing; the pool is faked anyway.
vi.mock("../src/session.ts", async (original) => ({
  ...(await original<typeof import("../src/session.ts")>()),
  desktopProblem: () => undefined,
}));

const APPS = { mail: ["thunderbird"], notes: ["gnome-text-editor"] };

function setup(model?: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  const reply = (message: ReturnType<typeof fauxAssistantMessage>) => (request: ModelContext) => {
    requests.push(structuredClone(request));
    return message;
  };
  const self = `${faux.provider.id}/${faux.getModel().id}`;
  return {
    faux,
    requests,
    reply,
    open: () =>
      createNudge(
        {
          database: ":memory:",
          models,
          model: { provider: faux.provider.id, modelId: faux.getModel().id },
          extensions: [{ extension: desktop, settings: { model: model ?? self, apps: APPS } }],
        },
        context,
      ),
  };
}

const json = (request: ModelContext | undefined) => JSON.stringify(request?.messages ?? []);
const isWorker = (request: ModelContext) => json(request).includes("You operate desktop apps");

/** Tools a request offers; pi-durable sends them in system messages. */
function toolsOf(request: ModelContext | undefined): string[] {
  return (request?.messages ?? []).flatMap((m) =>
    m.role === "system" ? (m.toolsAdded ?? []).map((t) => t.name) : [],
  );
}

async function say(nudge: Nudge, text: string): Promise<void> {
  const author = { playerId: "owner", displayName: "Vegard" };
  const settled = await (await nudge.submit(LOBBY, { text, author }, context)).wait(context);
  if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
}

let nudge: Nudge | undefined;
afterEach(async () => {
  await nudge?.close(context);
  nudge = undefined;
});

describe("desktop extension", () => {
  it("delegates to a desktop agent on its own model, and the window's personal data never leaves", async () => {
    const { faux, requests, reply, open } = setup();
    faux.setResponses([
      reply(
        fauxAssistantMessage([fauxToolCall("use_desktop", { task: "Who wrote the last mail?" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(
        fauxAssistantMessage([fauxToolCall("desktop_launch", { app: "notes" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(fauxAssistantMessage([fauxText("It is from ⟦EMAIL1⟧.")])),
      reply(fauxAssistantMessage([fauxText("Done.")])),
    ]);
    nudge = await open();
    await say(nudge, "Who wrote the last mail?");

    expect(requests).toHaveLength(4);
    expect(requests.map(isWorker)).toEqual([false, true, true, false]);
    // The room offers only `use_desktop`, naming the apps; the desktop tools are the worker's alone.
    expect(toolsOf(requests[0])).toContain("use_desktop");
    expect(toolsOf(requests[0])).not.toContain("desktop_click");
    expect(JSON.stringify(requests[0])).toContain("desktop of this room's own: mail, notes.");
    expect(toolsOf(requests[1])).toContain("desktop_click");
    expect(toolsOf(requests[1])).not.toContain("use_desktop");
    expect(json(requests[1])).toContain("desktop_launch: mail, notes.");
    expect(fake.calls).toContain("launch notes");
    expect(json(requests[2])).toContain("⟦EMAIL1⟧");
    for (const request of requests) expect(json(request)).not.toContain(EMAIL);
    expect(opened.at(-1)?.homeDir).toMatch(/\/conversation-\d+$/);
    expect(opened.at(-1)?.apps).toEqual(APPS);
  });

  it("asks the room to approve a consequential step, and carries on on the same desktop once approved", async () => {
    const { faux, requests, reply, open } = setup();
    const action = 'Click "Send" to send the reply to ⟦EMAIL1⟧';
    faux.setResponses([
      reply(
        fauxAssistantMessage(
          [fauxToolCall("use_desktop", { task: "Reply yes to the last mail" })],
          {
            stopReason: "toolUse",
          },
        ),
      ),
      reply(
        fauxAssistantMessage([fauxToolCall("desktop_confirm", { action })], {
          stopReason: "toolUse",
        }),
      ),
      reply(fauxAssistantMessage([fauxText("It waits for your approval.")])),
      reply(
        fauxAssistantMessage([fauxToolCall("desktop_click", { ref: "e9" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(fauxAssistantMessage([fauxText("Sent the reply.")])),
      reply(fauxAssistantMessage([fauxText("The reply is sent.")])),
    ]);
    nudge = await open();
    await say(nudge, "Reply yes to the last mail");

    const [pending] = await nudge.approvals.list(LOBBY, context);
    expect(pending).toMatchObject({ extension: "desktop", kind: "confirm", status: "pending" });
    expect(pending!.summary).toMatch(/^On the desktop: Click "Send"/);
    expect(json(requests[2])).toContain(`approval ${pending!.id}`);
    const clicks = fake.calls.filter((c) => c === "click e9").length;
    const home = opened.at(-1)?.homeDir;

    const decided = await nudge.approvals.decide(
      LOBBY,
      pending!.id,
      { approve: true, by: { playerId: "owner", displayName: "Vegard" } },
      context,
    );
    expect(decided).toMatchObject({ status: "done", result: "Sent the reply." });
    expect(isWorker(requests[3]!)).toBe(true);
    expect(json(requests[3])).toContain("they approved it");
    expect(fake.calls.filter((c) => c === "click e9").length).toBe(clicks + 1);
    expect(opened.at(-1)?.homeDir).toBe(home);
  });

  it("says what it is doing while it runs", async () => {
    const { faux, reply, open } = setup();
    let release!: () => void;
    const clicked = new Promise<void>((resolve) => (release = resolve));
    const click = fake.desktop.click;
    fake.desktop.click = async (ref, options) => {
      await clicked;
      return click(ref, options);
    };
    faux.setResponses([
      reply(
        fauxAssistantMessage([fauxToolCall("use_desktop", { task: "Open the mail" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(
        fauxAssistantMessage([fauxToolCall("desktop_click", { ref: "e5" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(fauxAssistantMessage([fauxText("Opened.")])),
      reply(fauxAssistantMessage([fauxText("Opened.")])),
    ]);
    nudge = await open();
    const room = await nudge.rooms.get(LOBBY, context);
    const answered = say(nudge, "Open the mail");
    let output: string | undefined;
    for (let i = 0; i < 200 && !output?.includes("Clicking"); i++) {
      await new Promise((r) => setTimeout(r, 10));
      const live = await nudge.harness.snapshot(LiveDoc, room!.conversationId as never, context);
      output = live?.tools?.find((tool) => tool.name === "use_desktop")?.output;
    }
    release();
    await answered;
    fake.desktop.click = click;
    expect(output).toBe('Starting the desktop…\nClicking "Button e5"…\n');
  });

  it("explains a desktop model the assistant does not know", async () => {
    const { faux, requests, reply, open } = setup("nowhere/no-model");
    faux.setResponses([
      reply(
        fauxAssistantMessage([fauxToolCall("use_desktop", { task: "Anything" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(fauxAssistantMessage([fauxText("Sorry.")])),
    ]);
    nudge = await open();
    await say(nudge, "Do something");
    expect(json(requests[1])).toContain(
      'The desktop model \\"nowhere/no-model\\" is not available.',
    );
  });

  it("checks its settings", async () => {
    const { open } = setup("no-slash");
    await expect(open()).rejects.toThrow(/Invalid settings for extension "desktop"/);
  });
});
