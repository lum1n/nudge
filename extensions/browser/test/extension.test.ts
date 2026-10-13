import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import browser from "../src/extension.ts";
import { fakeBrowser } from "./fake-browser.ts";

const context = BACKGROUND_CONTEXT;
const EMAIL = "ola.nordmann@example.no";

const fake = fakeBrowser(
  (n) =>
    `URL: https://example.no/${n}\n\n- heading "Kontakt" [level=1]\n- text: Skriv til ${EMAIL}`,
);
const profiles: string[] = [];
vi.mock("../src/pool.ts", () => ({
  withBrowser: (options: { profileDir: string }, _idleMs: number, use: (b: unknown) => unknown) => {
    profiles.push(options.profileDir);
    return use({ ...fake.browser, useLogins: () => {} });
  },
}));

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
          extensions: [{ extension: browser, settings: { model: model ?? self } }],
        },
        context,
      ),
  };
}

const json = (request: ModelContext | undefined) => JSON.stringify(request?.messages ?? []);
const isWorker = (request: ModelContext) => json(request).includes("You operate a web browser");

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

describe("browser extension", () => {
  it("delegates to a browser agent on its own model, and the page's personal data never leaves", async () => {
    const { faux, requests, reply, open } = setup();
    faux.setResponses([
      reply(
        fauxAssistantMessage(
          [fauxToolCall("browse", { task: "Find the contact address on example.no" })],
          { stopReason: "toolUse" },
        ),
      ),
      reply(
        fauxAssistantMessage([fauxToolCall("browser_navigate", { url: "https://example.no" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(fauxAssistantMessage([fauxText("The contact address is ⟦EMAIL1⟧.")])),
      reply(fauxAssistantMessage([fauxText("Done.")])),
    ]);
    nudge = await open();
    await say(nudge, "What is the contact address on example.no?");

    expect(requests).toHaveLength(4);
    const [room, worker, workerAgain, roomAgain] = requests;
    expect([room, worker, workerAgain, roomAgain].map((r) => isWorker(r!))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // The room offers only `browse`; the browser tools are the worker's alone.
    expect(toolsOf(room)).toContain("browse");
    expect(toolsOf(room)).not.toContain("browser_click");
    expect(toolsOf(worker)).toContain("browser_click");
    expect(toolsOf(worker)).not.toContain("browse");
    expect(fake.calls).toContain("navigate https://example.no");
    // The page text reached the worker's model redacted; the answer went back to the room redacted too.
    expect(json(workerAgain)).toContain("⟦EMAIL1⟧");
    expect(json(roomAgain)).toContain("The contact address is ⟦EMAIL1⟧.");
    for (const request of requests) expect(json(request)).not.toContain(EMAIL);
    expect(profiles.at(-1)).toMatch(/conversation-\d+$/);
  });

  it("explains a browser model the assistant does not know", async () => {
    const { faux, requests, reply, open } = setup("nowhere/no-model");
    faux.setResponses([
      reply(
        fauxAssistantMessage([fauxToolCall("browse", { task: "Anything" })], {
          stopReason: "toolUse",
        }),
      ),
      reply(fauxAssistantMessage([fauxText("Sorry.")])),
    ]);
    nudge = await open();
    await say(nudge, "Look something up");
    expect(json(requests[1])).toContain(
      'The browser model \\"nowhere/no-model\\" is not available.',
    );
  });

  it("checks its settings", async () => {
    const { open } = setup("no-slash");
    await expect(open()).rejects.toThrow(/Invalid settings for extension "browser"/);
  });
});
