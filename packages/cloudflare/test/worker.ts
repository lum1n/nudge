import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { NudgeOptions } from "@nudge/core";
import { NudgeAssistant as Base } from "../src/index.ts";

export { default } from "../src/index.ts";

/** Answers every request with "On it." */
export class NudgeAssistant extends Base {
  protected override options(): Partial<NudgeOptions> {
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage("On it.")));
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
  }
}
