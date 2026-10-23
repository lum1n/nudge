import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge } from "@nudge/core";
import { describe, expect, it } from "vitest";
import { nerExtension } from "../src/index.ts";

describe("the extension", () => {
  it("adds its detectors to the assistant's, so the model sees placeholders", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [{ extension: nerExtension, settings: { extraNames: ["Tiril"] } }],
      },
      BACKGROUND_CONTEXT,
    );
    // Its own names are hidden; the street address stays readable (ADR 15).
    expect(
      nudge.redact("Tiril og Kari Nordmann bor i Storgata 5B, 0151 Oslo. Ring 912 34 567."),
    ).toBe("⟦NAME1⟧ og ⟦NAME2⟧ bor i Storgata 5B, 0151 Oslo. Ring ⟦PHONE1⟧.");
    await nudge.close(BACKGROUND_CONTEXT);
  });
});
