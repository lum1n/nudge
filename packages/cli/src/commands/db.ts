import {
  BACKGROUND_CONTEXT,
  databaseEncryption,
  databaseKey,
  decryptDatabase,
  encryptDatabase,
  findAssistant,
  loadConfig,
  lockDatabase,
  redactStoredHistory,
} from "@nudge/core";
import type { AdminOptions } from "./admin.ts";

/**
 * Shows whether each assistant's database is encrypted, or encrypts or decrypts it in place, or
 * rewrites its history with placeholders (`redact`). Needs the database to itself, so it refuses
 * while `nudge serve` or a chat has it open.
 */
export async function db(
  options: AdminOptions & { readonly verb?: "encrypt" | "decrypt" | "redact" },
): Promise<void> {
  const config = await loadConfig(options.config);
  const assistants =
    options.assistant === undefined
      ? config.assistants
      : [findAssistant(config, options.assistant)];
  for (const assistant of assistants) {
    const { name, database = "" } = assistant;
    if (options.verb === "redact") {
      const done = await redactStoredHistory(config, assistant, BACKGROUND_CONTEXT);
      console.log(
        `${name}: ${done.entries} transcript entries and ${done.documents} remembered texts now ` +
          "hold placeholders; the values are only in the vault.",
      );
      continue;
    }
    const state = await databaseEncryption(database);
    if (options.verb === undefined) {
      const key = state === "encrypted" ? await databaseKey(database) : undefined;
      console.log(
        `${name}: ${database} ${
          state === "missing"
            ? "doesn't exist yet"
            : state === "plain"
              ? "is not encrypted"
              : `is encrypted (key: ${key?.source ?? "missing"})`
        }`,
      );
      continue;
    }
    if (state === "missing") {
      console.log(
        `${name}: ${database} doesn't exist yet; set NUDGE_DB_KEY to create it encrypted`,
      );
      continue;
    }
    if ((options.verb === "encrypt") === (state === "encrypted")) {
      console.log(`${name}: already ${state === "encrypted" ? "encrypted" : "not encrypted"}`);
      continue;
    }
    const unlock = await lockDatabase(database);
    try {
      if (options.verb === "encrypt") {
        const key = await encryptDatabase(database);
        console.log(
          key === "NUDGE_DB_KEY"
            ? `${name}: encrypted with NUDGE_DB_KEY; set it whenever Nudge runs`
            : `${name}: encrypted; the key is in ${key}. Without it the database can't be read:` +
                " back it up somewhere other than the database's own backups.",
        );
      } else {
        await decryptDatabase(database);
        console.log(`${name}: decrypted`);
      }
    } finally {
      await unlock();
    }
  }
}
