import {
  databaseEncryption,
  databaseKey,
  decryptDatabase,
  encryptDatabase,
  findAssistant,
  loadConfig,
  lockDatabase,
} from "@nudge/core";
import type { AdminOptions } from "./admin.ts";

/**
 * Shows whether each assistant's database is encrypted, or encrypts or decrypts it in place. Needs
 * the database to itself, so it refuses while `nudge serve` or a chat has it open.
 */
export async function db(
  options: AdminOptions & { readonly verb?: "encrypt" | "decrypt" },
): Promise<void> {
  const config = await loadConfig(options.config);
  const assistants =
    options.assistant === undefined
      ? config.assistants
      : [findAssistant(config, options.assistant)];
  for (const { name, database = "" } of assistants) {
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
