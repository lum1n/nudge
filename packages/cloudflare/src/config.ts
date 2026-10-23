import { ConfigError, type NudgeConfig, parseConfig } from "@nudge/core";
import type { NudgeAssistant } from "./assistant.ts";

export type NudgeEnv = {
  readonly NUDGE_ASSISTANT: DurableObjectNamespace<NudgeAssistant>;
  /**
   * The assistants, as `nudge.json` has them: a JSON object or its text. Databases are the Durable
   * Objects' own, and extensions are given in code (`NudgeAssistant.options`).
   */
  readonly NUDGE_CONFIG?: unknown;
  /** Lets `POST /v1/a/<assistant>/claim` make the first player, once. */
  readonly NUDGE_CLAIM_SECRET?: string;
  /** The Worker's address as clients reach it, for pairing links; default each request's origin. */
  readonly NUDGE_PUBLIC_URL?: string;
  /** debug, info, warn or error; default info. Lines are JSON, for Workers Logs. */
  readonly NUDGE_LOG_LEVEL?: string;
};

/** `NUDGE_CONFIG`, checked; one assistant named "nudge" without it. */
export function readConfig(env: NudgeEnv): NudgeConfig {
  let value: unknown = env.NUDGE_CONFIG ?? { assistants: [{ name: "nudge" }] };
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch (error) {
      throw new ConfigError(`NUDGE_CONFIG is not valid JSON: ${(error as Error).message}`);
    }
  }
  const assistants = (value as { assistants?: unknown }).assistants;
  if (Array.isArray(assistants))
    for (const assistant of assistants as { name?: unknown; extensions?: unknown }[])
      if (assistant?.extensions !== undefined)
        throw new ConfigError(
          `Assistant "${String(assistant.name)}" lists extensions: on Cloudflare they are given in code, by NudgeAssistant.extensions`,
        );
  return parseConfig(value, "/");
}
