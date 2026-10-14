import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { createNudge, LOBBY } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

describe("model view", () => {
  it("shows the room as the provider gets it: placeholders, never the values", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Noted, I'll remember Storgata 5.")]);
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
      context,
    );
    await nudge.players.invite("Ann", context);
    const placeholder = await nudge.protect("Storgata 5", "ADDRESS");
    const author = { playerId: "ann", displayName: "Ann" };
    await (
      await nudge.submit(LOBBY, { text: "I live at Storgata 5", author }, context)
    ).wait(context);

    const view = await nudge.modelView(LOBBY, context);
    const text = JSON.stringify(view);
    expect(text).not.toContain("Storgata 5");
    expect(text).not.toContain("Ann");
    // The prompt's sections are there: who the assistant is, who is in the room (as placeholders).
    const system = view.find((m) => m.role === "system")!.text;
    expect(system).toContain("You are Nudge");
    expect(system).toContain("⟦NAME1⟧");
    expect(system).toMatch(/\[tools added: .*schedule_nudge/);
    expect(view.find((m) => m.role === "user")?.text).toBe(`⟦NAME1⟧: I live at ${placeholder}`);
    expect(view.find((m) => m.role === "assistant")?.text).toBe(
      `Noted, I'll remember ${placeholder}.`,
    );
    await nudge.close(context);
  });
});
