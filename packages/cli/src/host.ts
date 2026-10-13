import { appendFileSync } from "node:fs";
import type { AssistantConfig, NudgeOptions } from "@nudge/core";

/**
 * What every command that runs an assistant passes to it: errors to stderr, and with
 * NUDGE_DEBUG_REQUESTS=1 every request, exactly as the provider gets it, appended next to the
 * database.
 */
export function hostOptions(assistant: AssistantConfig): Partial<NudgeOptions> {
  const dump = process.env.NUDGE_DEBUG_REQUESTS
    ? `${assistant.database}.requests.jsonl`
    : undefined;
  if (dump !== undefined) console.log(`${assistant.name}: writing requests to ${dump}`);
  return {
    onReport: (error) => console.error(error),
    privacy: dump
      ? { onRequest: (request) => appendFileSync(dump, `${JSON.stringify(request)}\n`) }
      : undefined,
  };
}
