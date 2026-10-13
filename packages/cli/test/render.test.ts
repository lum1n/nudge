import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge } from "@nudge/core";
import { describe, expect, it } from "vitest";
import { ChatRenderer } from "../src/render.ts";

const context = BACKGROUND_CONTEXT;
// oxlint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[\d+m/g, "");

describe("ChatRenderer", () => {
  it("streams answers and shows messages from other clients", async () => {
    const faux = fauxProvider({ tokensPerSecond: 2000, tokenSize: { min: 2, max: 4 } });
    faux.setResponses([
      fauxAssistantMessage("Hello there, Ann and Bo."),
      fauxAssistantMessage("Sure."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
      context,
    );
    let out = "";
    const renderer = new ChatRenderer((text) => (out += text), "Nudge", "mine");
    const stream = await nudge.attach(nudge.lobbyId, context);
    renderer.history(stream.snapshot);
    stream.start(async (events) => events.forEach((event) => renderer.event(event)));

    const ann = { playerId: "ann", displayName: "Ann", clientId: "mine" };
    const bo = { playerId: "bo", displayName: "Bo", clientId: "theirs" };
    await (await nudge.submit(nudge.lobbyId, { text: "hi", author: ann }, context)).wait(context);
    await (await nudge.submit(nudge.lobbyId, { text: "help?", author: bo }, context)).wait(context);
    await nudge.harness.waitForIdle(context);
    await stream.stop();
    await nudge.close(context);

    expect(plain(out)).toBe("Nudge: Hello there, Ann and Bo.\nBo: help?\nNudge: Sure.\n");
  });

  it("prints deltas of a slow answer once each", async () => {
    const text =
      "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.";
    const faux = fauxProvider({ tokensPerSecond: 60, tokenSize: { min: 1, max: 2 } });
    faux.setResponses([fauxAssistantMessage(text)]);
    const models = createModels();
    models.setProvider(faux.provider);
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        settings: { progress: { partialIntervalMs: 20 } },
      },
      context,
    );
    let out = "";
    let updates = 0;
    const renderer = new ChatRenderer((chunk) => (out += chunk), "Nudge", "mine");
    const stream = await nudge.attach(nudge.lobbyId, context);
    stream.start(async (events) =>
      events.forEach((event) => {
        if (event.type === "message_update") updates++;
        renderer.event(event);
      }),
    );
    await (await nudge.submit(nudge.lobbyId, { text: "count" }, context)).wait(context);
    await nudge.harness.waitForIdle(context);
    await stream.stop();
    await nudge.close(context);

    expect(updates).toBeGreaterThan(1);
    expect(plain(out)).toBe(`Nudge: ${text}\n`);
  });
});
