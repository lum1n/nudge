import type { Context } from "@earendil-works/chord";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type AssistantConfig,
  ConfigError,
  loadConfig,
  type NudgeConfig,
  parseConfig,
} from "../config.ts";
import {
  type RawAssistant,
  type RawConfig,
  rawAssistant,
  readRawConfig,
  writeRawConfig,
} from "../config-file.ts";
import { loadExtensions } from "../extensions/loader.ts";
import {
  type ExtensionChoice,
  type ExtensionSetup,
  listExtensionSetups,
  saveExtensionSetups,
} from "../extensions/settings.ts";
import type { InstalledExtension, Nudge } from "../nudge.ts";

export class AssistantNotFound extends Error {
  override name = "AssistantNotFound";
  constructor(readonly assistant: string) {
    super(`No assistant "${assistant}"`);
  }
}

export class AssistantExists extends Error {
  override name = "AssistantExists";
  constructor(readonly assistant: string) {
    super(`There is already an assistant "${assistant}"`);
  }
}

/** What a new assistant starts with; everything but its name can change later. */
export type AssistantDraft = Pick<AssistantConfig, "name"> & AssistantChange;

/** A change to an assistant's settings: a value sets it, `null` takes it out of the config. */
export type AssistantChange = {
  readonly [K in ChangeableKey]?: AssistantConfig[K] | null;
};

type ChangeableKey = "displayName" | "model" | "timeZone" | "instructions" | "budget";
const CHANGEABLE: readonly ChangeableKey[] = [
  "displayName",
  "model",
  "timeZone",
  "instructions",
  "budget",
];

export type AssistantsOptions = {
  /** The config file the server keeps; it is rewritten on every change. */
  readonly configPath: string;
  /** Opens one assistant of the config, with whatever the host adds (models, logging). */
  readonly open: (config: NudgeConfig, assistant: AssistantConfig) => Promise<Nudge>;
  readonly context: Context;
  readonly say?: (line: string) => void;
};

/**
 * The assistants a server runs, kept in step with its config file. Creating, changing and deleting
 * one happens while the others keep running: a change reopens that assistant alone, so its open
 * sockets end and clients connect again. Every change opens the assistant first and writes the
 * file only once that worked, so a change that fails leaves both as they were. Changes run one at
 * a time.
 *
 * `running` is the live map the HTTP server looks assistants up in.
 */
export class Assistants {
  readonly running = new Map<string, Nudge>();
  /** The settings each running assistant was opened with, to tell what a reload changed. */
  private readonly opened = new WeakMap<Nudge, AssistantConfig>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly configPath: string;
  private readonly say: (line: string) => void;

  private constructor(private readonly options: AssistantsOptions) {
    this.configPath = resolve(options.configPath);
    this.say = options.say ?? (() => {});
  }

  /** Opens every assistant in the config; one that fails closes those already open. */
  static async open(options: AssistantsOptions): Promise<Assistants> {
    const assistants = new Assistants(options);
    const config = await loadConfig(assistants.configPath);
    try {
      for (const entry of config.assistants)
        assistants.running.set(entry.name, await assistants.track(config, entry));
    } catch (error) {
      await assistants.close();
      throw error;
    }
    return assistants;
  }

  /** The assistants' settings as the config has them, in its order. */
  async list(): Promise<AssistantConfig[]> {
    return (await loadConfig(this.configPath)).assistants;
  }

  /** Adds an assistant with a database of its own and opens it. */
  create(draft: AssistantDraft): Promise<Nudge> {
    return this.serially(async () => {
      const raw = await readRawConfig(this.configPath);
      if (raw.assistants.some((assistant) => assistant.name === draft.name))
        throw new AssistantExists(draft.name);
      const entry: RawAssistant = { name: draft.name };
      applyChange(entry, draft);
      raw.assistants.push(entry);
      const config = this.parse(raw);
      const parsed = config.assistants.find((assistant) => assistant.name === draft.name)!;
      // A file left where the new database goes would hand it someone else's history.
      if (parsed.database !== undefined && existsSync(parsed.database))
        throw new ConfigError(
          `${parsed.database} already exists: move it away, or give the assistant another name`,
        );
      const nudge = await this.track(config, parsed);
      try {
        await writeRawConfig(this.configPath, raw);
      } catch (error) {
        await nudge.close(this.options.context);
        throw error;
      }
      this.running.set(draft.name, nudge);
      this.say(`${draft.name}: created`);
      return nudge;
    });
  }

  /** Changes an assistant's settings and reopens it with them. */
  update(name: string, change: AssistantChange): Promise<Nudge> {
    return this.serially(async () => {
      const raw = await readRawConfig(this.configPath);
      const entry = this.entryOf(raw, name);
      applyChange(entry, change);
      const nudge = await this.reopen(this.parse(raw), name);
      await writeRawConfig(this.configPath, raw);
      this.say(`${name}: settings changed`);
      return nudge;
    });
  }

  /**
   * Deletes an assistant: `backup` copies it first (it gets a config holding this assistant
   * alone), then its extensions retire (federation tells its guests' homes), it is closed, taken
   * out of the config, and its database, key and extensions' data are removed. Returns what
   * `backup` returned.
   */
  remove<T>(name: string, backup: (config: NudgeConfig) => Promise<T>): Promise<T> {
    return this.serially(async () => {
      const raw = await readRawConfig(this.configPath);
      this.entryOf(raw, name);
      const config = this.parse(raw);
      const entry = config.assistants.find((assistant) => assistant.name === name)!;
      const kept = await backup({ ...config, assistants: [entry] });
      const nudge = this.running.get(name);
      this.running.delete(name);
      if (nudge !== undefined) {
        await nudge.retire(this.options.context);
        await nudge.close(this.options.context);
      }
      raw.assistants = raw.assistants.filter((assistant) => assistant.name !== name);
      await writeRawConfig(this.configPath, raw);
      if (entry.database !== undefined) await removeFiles(entry.database);
      this.say(`${name}: deleted`);
      return kept;
    });
  }

  /** The assistant's extensions as the settings page shows them. */
  extensionSetups(name: string): Promise<ExtensionSetup[]> {
    return listExtensionSetups(this.configPath, name);
  }

  /** Sets up the assistant's extensions as `choices` say, and writes them once they started. */
  saveExtensionSetups(
    name: string,
    choices: readonly ExtensionChoice[],
  ): Promise<ExtensionSetup[]> {
    return this.serially(async () => {
      await saveExtensionSetups(this.configPath, name, choices, async (config) => {
        const nudge = this.running.get(name);
        const entry = config.assistants.find((assistant) => assistant.name === name);
        if (nudge === undefined || entry === undefined) return;
        let installed;
        try {
          installed = await nudge.reloadExtensions(
            await loadExtensions(entry.extensions ?? [], { fresh: true }),
          );
        } catch (error) {
          // An extension that won't start, such as one missing its token, is the admin's to fix.
          throw error instanceof ConfigError
            ? error
            : new ConfigError(`Nothing changed: ${(error as Error).message}`);
        }
        this.say(`${name}: extensions set up: ${describe(installed)}`);
      });
      return listExtensionSetups(this.configPath, name);
    });
  }

  /**
   * Reads the config file again, as after an edit by hand: opens assistants that are new in it,
   * closes those no longer in it, reopens those whose settings changed, and reinstalls every
   * other one's extensions. One assistant that fails doesn't stop the rest.
   */
  reload(): Promise<void> {
    return this.serially(async () => {
      const config = await loadConfig(this.configPath);
      const names = new Set(config.assistants.map((assistant) => assistant.name));
      for (const [name, nudge] of this.running) {
        if (names.has(name)) continue;
        this.running.delete(name);
        await nudge.close(this.options.context);
        this.say(`${name}: no longer in the config; closed`);
      }
      for (const entry of config.assistants) {
        try {
          const nudge = this.running.get(entry.name);
          if (nudge === undefined) {
            this.running.set(entry.name, await this.track(config, entry));
            this.say(`${entry.name}: opened`);
          } else if (!sameSettings(this.opened.get(nudge), entry)) {
            await this.reopen(config, entry.name);
            this.say(`${entry.name}: reopened with its new settings`);
          } else {
            const installed = await nudge.reloadExtensions(
              await loadExtensions(entry.extensions ?? [], { fresh: true }),
            );
            this.say(`${entry.name}: extensions reloaded: ${describe(installed)}`);
          }
        } catch (error) {
          this.say(`${entry.name}: reload failed, left as it was: ${(error as Error).message}`);
        }
      }
    });
  }

  /** Closes every assistant. */
  async close(): Promise<void> {
    await this.queue.catch(() => {});
    for (const [name, nudge] of this.running) {
      this.running.delete(name);
      await nudge.close(this.options.context);
    }
  }

  /** Closes the running assistant and opens it with `config`; on failure, with what it had. */
  private async reopen(config: NudgeConfig, name: string): Promise<Nudge> {
    const entry = config.assistants.find((assistant) => assistant.name === name)!;
    const old = this.running.get(name);
    const before = old === undefined ? undefined : this.opened.get(old);
    if (old !== undefined) {
      this.running.delete(name);
      await old.close(this.options.context);
    }
    try {
      const nudge = await this.track(config, entry);
      this.running.set(name, nudge);
      return nudge;
    } catch (error) {
      if (before !== undefined) this.running.set(name, await this.track(config, before));
      throw error;
    }
  }

  private async track(config: NudgeConfig, entry: AssistantConfig): Promise<Nudge> {
    const nudge = await this.options.open(config, entry);
    this.opened.set(nudge, entry);
    return nudge;
  }

  private entryOf(raw: RawConfig, name: string): RawAssistant {
    try {
      return rawAssistant(raw, name);
    } catch {
      throw new AssistantNotFound(name);
    }
  }

  private parse(raw: RawConfig): NudgeConfig {
    return parseConfig(raw, dirname(this.configPath));
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
}

function applyChange(entry: RawAssistant, change: AssistantChange): void {
  for (const key of CHANGEABLE) {
    const value = change[key];
    if (value === undefined) continue;
    if (value === null) delete entry[key];
    else entry[key] = structuredClone(value);
  }
}

/** Whether a reload may keep the assistant open: nothing but its extensions changed. */
function sameSettings(before: AssistantConfig | undefined, after: AssistantConfig): boolean {
  if (before === undefined) return true;
  const settings = (config: AssistantConfig) => JSON.stringify({ ...config, extensions: [] });
  return settings(before) === settings(after);
}

function describe(installed: readonly InstalledExtension[]): string {
  return installed.map((e) => `${e.name}${e.version ? ` ${e.version}` : ""}`).join(", ") || "none";
}

/** The database and everything beside it that belongs to it. */
async function removeFiles(database: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal", ".key", ".lock", ".requests.jsonl"])
    await rm(`${database}${suffix}`, { force: true });
  await rm(`${database}.extensions`, { recursive: true, force: true });
}
