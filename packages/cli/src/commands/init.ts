import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote ${path}.`);
  console.log(
    `Set ANTHROPIC_API_KEY, or add an OpenAI-compatible server under "providers", then run: nudge chat`,
  );
  console.log("nudge.example.json in the Nudge repository shows every option.");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
