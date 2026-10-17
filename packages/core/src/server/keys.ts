import { dirname, join, resolve } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import type { LocalProviderConfig } from "../config.ts";
import { buildModels } from "../models/providers.ts";
import { SecretStore } from "../secrets.ts";

/** Where a server keeps the model keys set on it: `server/keys` beside its config. */
export function serverKeysDir(configPath: string): string {
  return join(dirname(resolve(configPath)), "server", "keys");
}

const SERVER = "server";
const assistantScope = (assistant: string) => `assistant:${assistant}`;

/** Where a provider's key comes from for one assistant, as the server API shows it. */
export type KeySource =
  | { readonly from: "env"; readonly variables: readonly string[] }
  | { readonly from: "assistant" }
  | { readonly from: "server" };

/**
 * Model providers' API keys set on the server, such as one pasted in the setup wizard: for every
 * assistant, or for one. Kept in a `SecretStore` under the data directory, so they are encrypted
 * at rest and travel in backups. A key in the environment (`ANTHROPIC_API_KEY`, …) wins over
 * both, for servers whose keys are managed that way; then the assistant's, then the server's.
 * Nothing here hands a key back to a client.
 */
export class ServerKeys {
  private readonly store: SecretStore;

  /**
   * `dir` is `<data directory>/server/keys`; undefined keeps keys in memory, for tests.
   * `envKeys` names the environment variables set for a provider; default pi-ai's, over
   * `process.env`.
   */
  constructor(
    dir: string | undefined,
    private readonly envKeys: (provider: string) => readonly string[] = (provider) =>
      findEnvKeys(provider) ?? [],
  ) {
    this.store = new SecretStore(dir);
  }

  /** Sets the key for every assistant, or with `assistant` for that one alone. */
  set(provider: string, key: string, assistant?: string): void {
    this.store.set(assistant === undefined ? SERVER : assistantScope(assistant), provider, key);
  }

  /** False when there was no such key. */
  delete(provider: string, assistant?: string): boolean {
    return this.store.delete(
      assistant === undefined ? SERVER : assistantScope(assistant),
      provider,
    );
  }

  /** Forgets every key set for one assistant, as when it is deleted. */
  deleteAssistant(assistant: string): void {
    for (const provider of this.store.names(assistantScope(assistant)))
      this.store.delete(assistantScope(assistant), provider);
  }

  /** Where the key `assistant` would use for `provider` comes from; undefined when there is none. */
  source(provider: string, assistant?: string): KeySource | undefined {
    const variables = this.envKeys(provider);
    if (variables.length > 0) return { from: "env", variables: [...variables] };
    if (
      assistant !== undefined &&
      this.store.get(assistantScope(assistant), provider) !== undefined
    )
      return { from: "assistant" };
    if (this.store.get(SERVER, provider) !== undefined) return { from: "server" };
    return undefined;
  }

  /** The providers with a key set on the server, for everyone or for `assistant`. */
  providers(assistant?: string): string[] {
    const names = new Set(this.store.names(SERVER));
    if (assistant !== undefined)
      for (const name of this.store.names(assistantScope(assistant))) names.add(name);
    return [...names].sort();
  }

  /** The credentials one assistant's model catalog reads. */
  credentialsFor(assistant: string): CredentialStore {
    const read = (provider: string): Credential | undefined => {
      if (this.source(provider, assistant)?.from === "env") return undefined;
      const key =
        this.store.get(assistantScope(assistant), provider) ?? this.store.get(SERVER, provider);
      return key === undefined ? undefined : { type: "api_key", key };
    };
    return {
      read: async (provider) => read(provider),
      list: async () =>
        this.providers(assistant).map((providerId): CredentialInfo => ({
          providerId,
          type: "api_key",
        })),
      modify: async (provider, change) => {
        const next = await change(read(provider));
        if (next?.type === "api_key" && next.key !== undefined)
          this.set(provider, next.key, assistant);
        return next ?? read(provider);
      },
      delete: async (provider) => void this.delete(provider, assistant),
    };
  }
}

/**
 * Sends one tiny request to `provider` with `key`, through its cheapest model, and throws with the
 * provider's answer when that fails: a wrong key is refused before it is kept.
 */
export async function testProviderKey(
  provider: string,
  key: string,
  providers: readonly LocalProviderConfig[] = [],
): Promise<void> {
  const only: CredentialStore = {
    read: async (id) => (id === provider ? { type: "api_key", key } : undefined),
    list: async () => [{ providerId: provider, type: "api_key" }],
    modify: async () => ({ type: "api_key", key }),
    delete: async () => {},
  };
  const models = buildModels(providers, only);
  const cheapest = [...models.getModels(provider)].sort(
    (a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output),
  )[0];
  if (cheapest === undefined) throw new Error(`No models from "${provider}"`);
  const answer = await models.completeSimple(
    cheapest,
    { messages: [{ role: "user", content: "Reply with the word pong.", timestamp: Date.now() }] },
    { maxTokens: 16 },
  );
  if (answer.stopReason === "error" || answer.stopReason === "aborted")
    throw new Error(readableError(answer.errorMessage) ?? `${provider} refused the key`);
}

/**
 * A provider's error as a person reads it: `401 {"error":{"message":"invalid x-api-key"}}`
 * becomes `invalid x-api-key (401)`. Anything else is left as it is.
 */
export function readableError(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const status = /^(\d{3})\b/.exec(text)?.[1];
  const json = text.indexOf("{");
  if (json === -1) return text;
  try {
    const body = JSON.parse(text.slice(json)) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const message =
      typeof body.error === "string"
        ? body.error
        : typeof body.error?.message === "string"
          ? body.error.message
          : typeof body.message === "string"
            ? body.message
            : undefined;
    if (message === undefined) return text;
    return status === undefined ? message : `${message} (${status})`;
  } catch {
    return text;
  }
}
