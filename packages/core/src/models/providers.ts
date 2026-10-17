import {
  type ApiKeyAuth,
  type CredentialStore,
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { LocalProviderConfig } from "../config.ts";

/**
 * Every provider pi-ai knows (Anthropic, OpenAI, xAI, Google, OpenRouter, …; each reads its own key
 * from the environment, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or from `credentials`,
 * such as the keys set on the server), plus the configured OpenAI-compatible servers, which
 * replace a built-in provider with the same id.
 */
export function buildModels(
  providers: readonly LocalProviderConfig[] = [],
  credentials?: CredentialStore,
): MutableModels {
  const models = createModels(credentials === undefined ? {} : { credentials });
  for (const provider of builtinProviders()) models.setProvider(provider);
  for (const provider of providers) models.setProvider(localProvider(provider));
  return models;
}

function localProvider(config: LocalProviderConfig) {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  return createProvider<"openai-completions">({
    id: config.id,
    baseUrl,
    auth: {
      apiKey: config.apiKeyEnv
        ? envApiKeyAuth(`${config.id} API key`, [config.apiKeyEnv])
        : keyless(config.id),
    },
    api: openAICompletionsApi(),
    models: config.models.map((model): Model<"openai-completions"> => ({
      id: model.id,
      name: model.name ?? model.id,
      api: "openai-completions",
      provider: config.id,
      baseUrl,
      input: ["text"],
      reasoning: model.reasoning ?? false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 32_768,
      maxTokens: model.maxTokens ?? 4_096,
      compat: { supportsDeveloperRole: config.supportsDeveloperRole ?? false },
    })),
  });
}

function keyless(id: string): ApiKeyAuth {
  return {
    name: `${id} (no key)`,
    resolve: async () => ({ auth: { apiKey: "none" }, source: "keyless" }),
  };
}
