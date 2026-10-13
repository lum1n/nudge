import { defineDoc } from "@earendil-works/pi-durable";
import type { VaultEntry } from "./vault.ts";

/** The assistant's vault, one per storage. Stored raw on the host; only placeholders leave it. */
export const VaultDoc = defineDoc<{ entries: VaultEntry[] }>({
  kind: "nudge.vault",
  version: 1,
  scope: "session",
  initial: () => ({ entries: [] }),
});
