import { access, writeFile } from "node:fs/promises";
import { DEFAULT_MODEL, type NudgeConfig } from "@nudge/core";

export async function init(path: string): Promise<void> {
  if (await exists(path)) {
    console.log(`${path} already exists; leaving it as it is.`);
    return;
  }
  const config: NudgeConfig = {
    assistants: [
      { name: "nudge", displayName: "Nudge", database: "data/nudge.sqlite", model: DEFAULT_MODEL },
    ],
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote ${path}.`);
  console.log(
    `Set ANTHROPIC_API_KEY, or add an OpenAI-compatible server under "providers", then run: nudge chat`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
