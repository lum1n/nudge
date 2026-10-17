import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionConfig } from "../config.ts";
import { bundled } from "../extensions/settings.ts";

/**
 * The extensions a new assistant starts with: federation, at the server's public address, so its
 * people can join other assistants and others can join it (ADR 10). None without a public address,
 * since other assistants couldn't reach it. Taken from the release's bundle, or from
 * `extensions/` beside the config in a checkout.
 */
export function defaultExtensions(configPath: string, publicUrl?: string): ExtensionConfig[] {
  if (publicUrl === undefined) return [];
  const from = extensionFrom(configPath, "federation", "@nudge/ext-federation");
  return from === undefined ? [] : [{ from, settings: { server: publicUrl.replace(/\/+$/, "") } }];
}

function extensionFrom(configPath: string, dir: string, name: string): string | undefined {
  if (bundled().includes(name)) return name;
  const beside = join(dirname(resolve(configPath)), "extensions", dir, "package.json");
  return existsSync(beside) ? `./extensions/${dir}` : undefined;
}
