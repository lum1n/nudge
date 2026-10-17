import { appendFileSync } from "node:fs";
import {
  type AssistantConfig,
  type Assistants,
  findAssistant,
  loadConfig,
  loadExtensions,
  type Nudge,
  type NudgeOptions,
} from "@nudge/core";

/**
 * What every command that runs an assistant passes to it: new databases encrypted, errors to
 * stderr, and with NUDGE_DEBUG_REQUESTS=1 every request, exactly as the provider gets it, appended
 * next to the database.
 */
export function hostOptions(assistant: AssistantConfig): Partial<NudgeOptions> {
  const dump = process.env.NUDGE_DEBUG_REQUESTS
    ? `${assistant.database}.requests.jsonl`
    : undefined;
  if (dump !== undefined) console.log(`${assistant.name}: writing requests to ${dump}`);
  return {
    // Every database the CLI makes is encrypted (ADR 11); backups carry its key file.
    encryptNew: true,
    onReport: (error) => console.error(error),
    privacy: dump
      ? { onRequest: (request) => appendFileSync(dump, `${JSON.stringify(request)}\n`) }
      : undefined,
  };
}

/**
 * On SIGHUP (`nudge reload`), reads the config again: new assistants open, removed ones close,
 * changed ones reopen, and the rest reinstall their extensions. Returns the function that stops
 * listening.
 */
export function reloadOnHangup(
  assistants: Assistants,
  say: (line: string) => void = console.log,
): () => void {
  const onHangup = () => {
    assistants
      .reload()
      .catch((error: unknown) => say(`reload failed: ${(error as Error).message}`));
  };
  process.on("SIGHUP", onHangup);
  return () => process.off("SIGHUP", onHangup);
}

/**
 * On SIGHUP, reinstalls the extensions of one assistant this process holds open, such as for
 * `nudge chat`: the session keeps its assistant, so only extensions change.
 */
export function reloadExtensionsOnHangup(
  configPath: string,
  name: string,
  nudge: Nudge,
  say: (line: string) => void = console.log,
): () => void {
  let running = Promise.resolve();
  const reload = async () => {
    const assistant = findAssistant(await loadConfig(configPath), name);
    const installed = await nudge.reloadExtensions(
      await loadExtensions(assistant.extensions ?? [], { fresh: true }),
    );
    const names = installed.map((e) => `${e.name}${e.version ? ` ${e.version}` : ""}`);
    say(`${assistant.name}: extensions reloaded: ${names.join(", ") || "none"}`);
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
