import type { Context } from "@earendil-works/chord";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { LocalProviderConfig, ModelChoice, ServerSettings } from "../config.ts";
import { readRawConfig, writeRawConfig } from "../config-file.ts";
import { type ClientInfo, normalizePairingCode, type Player } from "../identity/directory.ts";
import type { Assistants } from "./assistants.ts";
import type { ServerKeys } from "./keys.ts";
import type { ServerOwner, ServerOwners } from "./owners.ts";

/** What the setup wizard asks (ADR 11), sent once at the end. */
export type SetupChoices = {
  readonly assistant: { readonly name: string; readonly displayName?: string };
  readonly model: ModelChoice;
  /** The provider's key, kept on the server for every assistant. */
  readonly key?: { readonly provider: string; readonly key: string };
  /** A local OpenAI-compatible server found during setup, such as Ollama, that `model` is on. */
  readonly localProvider?: LocalProviderConfig;
  /** The person setting it up: its first player, so its admin, and the server's owner. */
  readonly you: { readonly displayName: string };
  readonly server?: ServerSettings;
  /** Nightly backups beside the config, the last 14 kept; default on. */
  readonly backups?: boolean;
};

export type SetupResult = {
  readonly assistant: string;
  readonly player: Player;
  /** The player's token, for the client that set the server up. */
  readonly token: string;
  readonly clientId: string;
  readonly owner: ServerOwner;
  /** The owner's server token, for the same client. */
  readonly serverToken: string;
};

export type SetupTarget = {
  readonly configPath: string;
  readonly assistants: Assistants;
  readonly keys: ServerKeys;
  readonly owners: ServerOwners;
};

/** Crockford's base 32, as pairing codes: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A one-time code for setting a server up: `XXXX-XXXX-XXXX`, 60 bits, since anyone who can reach
 * the server in setup mode may try it (they get a few tries, see `SetupCodes`).
 */
export function newSetupCode(): string {
  const chars = [...randomBytes(12)].map((byte) => ALPHABET[byte % ALPHABET.length]);
  return [0, 4, 8].map((at) => chars.slice(at, at + 4).join("")).join("-");
}

/**
 * The code a server in setup mode was given, and how many wrong ones it took: after `tries`
 * wrong codes, or past `expiresAt`, setup closes until the server restarts. Once claimed it stays
 * closed for good, since the server then has a config.
 */
export class SetupCodes {
  private wrong = 0;
  private claimed = false;

  constructor(
    private readonly code: string,
    private readonly tries = 10,
    private readonly expiresAt = Number.POSITIVE_INFINITY,
    private readonly now: () => number = Date.now,
  ) {}

  get open(): boolean {
    return !this.claimed && this.wrong < this.tries && this.now() < this.expiresAt;
  }

  /** Whether `code` is the one, counting it against the tries when it isn't. */
  check(code: string): boolean {
    if (!this.open) return false;
    if (normalizePairingCode(code) === normalizePairingCode(this.code)) return true;
    this.wrong += 1;
    return false;
  }

  /** Closes setup: the server is set up. */
  claim(): void {
    this.claimed = true;
  }
}

/**
 * Sets the server up as `choices` say: writes its config, keeps the key, creates the first
 * assistant with the person as its first player and admin, and makes them the server's owner.
 * Returns their tokens. Refuses a server that has a config already.
 */
export async function completeSetup(
  target: SetupTarget,
  choices: SetupChoices,
  client: ClientInfo,
  context: Context,
): Promise<SetupResult> {
  if (existsSync(target.configPath)) throw new Error("This server is set up already");
  const raw = await readRawConfig(target.configPath);
  if (choices.server !== undefined && Object.keys(choices.server).length > 0)
    raw.server = { ...choices.server };
  if (choices.localProvider !== undefined) raw.providers = [{ ...choices.localProvider }];
  // On the same disk, so it guards against mistakes more than a dead disk; the owner is told.
  if (choices.backups !== false) raw.backup = { dir: "backups", everyHours: 24, keep: 14 };
  await writeRawConfig(target.configPath, raw);
  let nudge;
  try {
    nudge = await target.assistants.create({
      name: choices.assistant.name,
      ...(choices.assistant.displayName === undefined
        ? {}
        : { displayName: choices.assistant.displayName }),
      model: choices.model,
    });
  } catch (error) {
    // Still not set up, so setup can be tried again.
    await rm(target.configPath, { force: true });
    throw error;
  }
  if (choices.key !== undefined) target.keys.set(choices.key.provider, choices.key.key);
  // The first player is the assistant's admin for good.
  const invited = await nudge.players.invite(choices.you.displayName, context);
  const owner = target.owners.add(choices.assistant.name, invited.player.id);
  const issued = target.owners.issue(owner.id, client);
  return {
    assistant: choices.assistant.name,
    player: invited.player,
    token: invited.token,
    clientId: invited.clientId,
    owner,
    serverToken: issued.token,
  };
}

/** A local model server setup found, with the models it has. */
export type LocalServer = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: string[];
};

/**
 * Model servers running on this machine that setup can offer: Ollama on its usual port. Each
 * answers within a second or is left out.
 */
export async function detectLocalServers(fetcher: typeof fetch = fetch): Promise<LocalServer[]> {
  const found: LocalServer[] = [];
  try {
    const response = await fetcher("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { models?: { name?: unknown }[] };
      const models = (body.models ?? [])
        .map((model) => model.name)
        .filter((name): name is string => typeof name === "string");
      if (models.length > 0)
        found.push({ id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models });
    }
  } catch {
    // Not running.
  }
  return found;
}
