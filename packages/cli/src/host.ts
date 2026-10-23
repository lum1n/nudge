import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type AssistantConfig,
  type Assistants,
  type DeepDetector,
  errorFields,
  findAssistant,
  loadConfig,
  loadExtensions,
  loggerFromEnv,
  ModelErrors,
  type Nudge,
  type NudgeConfig,
  type NudgeOptions,
  startLocalModel,
} from "@nudge/core";

let localModel: DeepDetector | undefined;

/**
 * Where this process's errors go: stderr, at `NUDGE_LOG_LEVEL` (default info), as JSON lines or,
 * on a terminal, as text (`NUDGE_LOG_FORMAT` says which).
 */
export const hostLog = loggerFromEnv(process.env, process.stderr.isTTY === true);

/** The last model errors of every assistant in this process, for the health check and owners. */
export const modelErrors = new ModelErrors();

/** Where a server keeps the local model's files: `server/models` beside its config. */
export function modelsDir(configPath: string): string {
  return join(dirname(resolve(configPath)), "server", "models");
}

/**
 * The local model every assistant in this process shares (ADR 14), downloaded the first time and
 * started once.
 */
export function sharedLocalModel(configPath: string): DeepDetector {
  localModel ??= startLocalModel(modelsDir(configPath), (line) => console.log(line));
  return localModel;
}

/** Whether the config turns the local model on: it is off unless asked for (ADR 15). */
export function localModelWanted(config: NudgeConfig | undefined): boolean {
  const deep = config?.privacy?.deep;
  return deep !== undefined && deep !== "off";
}

/**
 * What every command that runs an assistant passes to it: new databases encrypted, errors to
 * `hostLog`, model errors kept in `modelErrors`, the local model when the config turns it on,
 * and with NUDGE_DEBUG_REQUESTS=1 every request, exactly as the provider gets it, appended next
 * to the database.
 */
export function hostOptions(
  assistant: AssistantConfig,
  config: NudgeConfig,
  configPath: string,
): Partial<NudgeOptions> {
  const dump = process.env.NUDGE_DEBUG_REQUESTS
    ? `${assistant.database}.requests.jsonl`
    : undefined;
  if (dump !== undefined) console.log(`${assistant.name}: writing requests to ${dump}`);
  return {
    // Every database the CLI makes is encrypted (ADR 11); backups carry its key file.
    encryptNew: true,
    onReport: (error) =>
      hostLog.error("Assistant error", { assistant: assistant.name, ...errorFields(error) }),
    onModelError: (failure) => {
      const kept = modelErrors.record({ ...failure, assistant: assistant.name });
      hostLog.warn("Model request failed", {
        assistant: assistant.name,
        provider: kept.provider,
        model: kept.model,
        detail: kept.message,
      });
    },
    privacy: {
      ...(dump === undefined
        ? {}
        : { onRequest: (request) => appendFileSync(dump, `${JSON.stringify(request)}\n`) }),
      ...(localModelWanted(config) ? { deep: sharedLocalModel(configPath) } : {}),
    },
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
