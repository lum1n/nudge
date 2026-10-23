import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";

const BROWSER = join(import.meta.dirname, "../../../extensions/browser/src/index.ts");
const MCP = join(import.meta.dirname, "../../../extensions/mcp/src/index.ts");
const FAKE_MCP = join(import.meta.dirname, "../../../extensions/mcp/test/fake-server.mjs");
const HELLO = join(import.meta.dirname, "../../../extensions/hello/src/index.ts");

/**
 * A nudge.json with `extensions`; by default a browser extension that runs on OpenAI while the
 * assistant runs on Anthropic.
 */
function config(
  extensions: unknown[] = [{ from: BROWSER, settings: { model: "openai/gpt-5-mini" } }],
): string {
  const dir = mkdtempSync(join(tmpdir(), "nudge-doctor-"));
  const path = join(dir, "nudge.json");
  writeFileSync(
    path,
    JSON.stringify({
      assistants: [
        {
          name: "robin",
          model: { provider: "anthropic", modelId: "claude-sonnet-5" },
          extensions,
        },
      ],
    }),
  );
  return path;
}

async function lines(path = config()): Promise<string[]> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => printed.push(line));
  try {
    await doctor({ config: path });
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

  it("warns, without failing, of an MCP server whose images reach the model unredacted", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const server = { command: process.execPath, args: [FAKE_MCP] };
    const printed = await lines(
      config([
        {
          from: MCP,
          settings: {
            servers: {
              plain: server,
              shown: { ...server, unredactedImages: true },
              old: { ...server, images: true },
            },
          },
        },
      ]),
    );
    const warnings = printed.filter((line) => line.startsWith("warn "));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(
      /^warn robin: mcp: server shown passes images to the model unredacted; redaction reads only text/,
    );
    expect(warnings[1]).toContain("server old passes images");
    expect(warnings[1]).toContain("rename it unredactedImages");
    expect(printed.filter((line) => line.startsWith("FAIL"))).toEqual([]);
  });

  it("names an extension that fails to start, and still checks the others", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const printed = await lines(
      config([{ from: BROWSER, settings: { model: "no-slash" } }, { from: HELLO }]),
    );
    expect(
      printed.some((line) =>
        line.startsWith(
          "FAIL robin: browser: fails to start, so the assistant opens without it: Settings for the browser extension need fixing",
        ),
      ),
    ).toBe(true);
    expect(printed.some((line) => /^ok {3}robin: extensions browser .*, hello/.test(line))).toBe(
      true,
    );
  });
});
