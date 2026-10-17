import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigError, DEFAULT_CONFIG, type ExtensionConfig } from "./config.ts";

/** `nudge.json` as written, `$comment` keys and all, for changing it without losing them. */
export type RawConfig = { assistants: RawAssistant[] } & Record<string, unknown>;
export type RawAssistant = { name: string; extensions?: RawExtension[] } & Record<string, unknown>;
export type RawExtension = ExtensionConfig & { $comment?: unknown };

/** The config file as written; a missing one reads as the default config. */
export async function readRawConfig(path: string): Promise<RawConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return structuredClone(DEFAULT_CONFIG) as RawConfig;
    throw error;
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Replaces the config file at once, so a reader never sees half of it. */
export async function writeRawConfig(path: string, raw: RawConfig): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`);
  await rename(temporary, target);
}

export function rawAssistant(raw: RawConfig, name: string): RawAssistant {
  const found = Array.isArray(raw.assistants)
    ? raw.assistants.find((assistant) => assistant.name === name)
    : undefined;
  if (found === undefined) throw new ConfigError(`No assistant "${name}" in the config`);
  return found;
}
