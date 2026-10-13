import { appendFileSync } from "node:fs";
import {
  type AssistantConfig,
  loadConfig,
  loadExtensions,
  type Nudge,
  type NudgeOptions,
} from "@nudge/core";

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

/**
 * On SIGHUP (`nudge reload`), reads the config again and reinstalls each running assistant's
 * extensions. Only extensions change; a new model or a new assistant needs a restart. Returns the
 * function that stops listening.
 */
export function reloadOnHangup(
  configPath: string,
  assistants: ReadonlyMap<string, Nudge>,
  say: (line: string) => void = console.log,
): () => void {
  let running = Promise.resolve();
  const reload = async () => {
    const config = await loadConfig(configPath);
    for (const [name, nudge] of assistants) {
      const assistant = config.assistants.find((a) => a.name === name);
      if (assistant === undefined) {
        say(`${name}: no longer in ${configPath}; restart to drop it`);
        continue;
      }
      const installed = await nudge.reloadExtensions(
        await loadExtensions(assistant.extensions ?? [], { fresh: true }),
      );
      const names = installed.map((e) => `${e.name}${e.version ? ` ${e.version}` : ""}`);
      say(`${name}: extensions reloaded: ${names.join(", ") || "none"}`);
    }
  };
  const onHangup = () => {
    running = running
      .then(reload)
      .catch((error: unknown) =>
        say(`reload failed, nothing changed: ${(error as Error).message}`),
      );
  };
  process.on("SIGHUP", onHangup);
  return () => process.off("SIGHUP", onHangup);
}
