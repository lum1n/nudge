import { defineDocFamily } from "@earendil-works/pi-durable";

// Stored in a document, so plain JSON.
export type Script = {
  /** Lower case words joined by dashes, like `finn-glc`; unique within its room. */
  name: string;
  /** What it does and what it returns, in the room's words. */
  description: string;
  /** JavaScript, as the model wrote it, with placeholders for personal values. */
  code: string;
  createdAt: number;
  updatedAt: number;
  runs: number;
  lastRunAt?: number;
  /** Why the last run failed, if it did. */
  lastError?: string;
  /** Saved in answer to something private: only this player sees and runs it. */
  privateTo?: { playerId: string; displayName: string };
};

export type ScriptsState = { items: Script[] };

/** A room's saved scripts, keyed by room id. */
export const ScriptsDoc = defineDocFamily<ScriptsState, null>({
  kind: "scripts.list",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ items: [] }),
});

export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The longest script kept; anything longer is a program, not a check. */
export const MAX_CODE = 20_000;

/** `code` with `args` set first, after a leading `// @options:` line if it has one. */
export function withArgs(code: string, args: unknown): string {
  const line = `const args = ${JSON.stringify(args ?? {})};\n`;
  if (!code.startsWith("// @options:")) return line + code;
  const end = code.indexOf("\n");
  return end === -1 ? `${code}\n${line}` : code.slice(0, end + 1) + line + code.slice(end + 1);
}
