import { defineDoc } from "@earendil-works/pi-durable";
import type { VaultEntry } from "./vault.ts";

/**
 * The assistant's vault, one per storage: the only place raw personal values are kept (ADR 9).
 * Every change is stored whole, which drops the revisions before it, so a forgotten value leaves
 * no older copy behind.
 */
export const VaultDoc = defineDoc<{ entries: VaultEntry[] }>({
  kind: "nudge.vault",
  version: 1,
  scope: "session",
  initial: () => ({ entries: [] }),
  checkpointWhen: () => true,
});
