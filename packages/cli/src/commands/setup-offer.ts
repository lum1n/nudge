import { buildModels, DEFAULT_MODEL } from "@nudge/core";
import type { SetupProvider } from "@nudge/protocol";

/** The models setup offers, best first, of those the catalog has. */
const OFFERED: readonly { id: string; name: string; models: readonly string[] }[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: [DEFAULT_MODEL.modelId, "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  },
  { id: "openai", name: "OpenAI", models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.5", "gpt-6-luna"] },
];

export function offeredProviders(): SetupProvider[] {
  const catalog = buildModels();
  return OFFERED.flatMap((provider) => {
    const models = provider.models.flatMap((id) => {
      const model = catalog.getModel(provider.id, id);
      return model === undefined ? [] : [{ id, name: model.name }];
    });
    return models.length === 0
      ? []
      : [{ id: provider.id, name: provider.name, models, recommended: models[0]!.id }];
  });
}

/** An assistant's name as its address has it: lower case, dashes for the rest. */
export function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
