import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";

const BROWSER = join(import.meta.dirname, "../../../extensions/browser/src/index.ts");

/** A nudge.json whose browser extension runs on OpenAI while the assistant runs on Anthropic. */
function config(): string {
  const dir = mkdtempSync(join(tmpdir(), "nudge-doctor-"));
  const path = join(dir, "nudge.json");
  writeFileSync(
    path,
    JSON.stringify({
      assistants: [
        {
          name: "robin",
          model: { provider: "anthropic", modelId: "claude-sonnet-5" },
          extensions: [{ from: BROWSER, settings: { model: "openai/gpt-5-mini" } }],
        },
      ],
    }),
  );
  return path;
}

async function lines(): Promise<string[]> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => printed.push(line));
  try {
    await doctor({ config: config() });
  } finally {
    log.mockRestore();
  }
  return printed;
}

afterEach(() => vi.unstubAllEnvs());

describe("nudge doctor", () => {
  it("checks the browser model's credentials, not only the assistant's", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const missing = await lines();
    expect(missing).toContain("FAIL robin: browser uses openai/gpt-5-mini: credentials missing");
    expect(
      missing.some((line) => /^ok {3}robin: anthropic\/claude-sonnet-5: credentials/.test(line)),
    ).toBe(true);

    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const found = await lines();
    expect(
      found.some((line) => /^ok {3}robin: browser uses openai\/gpt-5-mini: credentials/.test(line)),
    ).toBe(true);
  });
});
