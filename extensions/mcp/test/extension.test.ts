import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import mcp, { fillVariables, toolName } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const FAKE = join(import.meta.dirname, "fake-server.mjs");
const author = { playerId: "owner", displayName: "Vegard" };

/** The tools and prompt in effect at the end of a request; changes come as later system messages. */
function current(request: ModelContext | undefined): { tools: string[]; prompt: string } {
  const tools = new Set<string>();
  const sections: Record<string, string> = {};
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const [key, text] of Object.entries(message.sections ?? {}))
      if (text === null) delete sections[key];
      else sections[key] = text;
  }
  return { tools: [...tools], prompt: Object.values(sections).join("\n") };
}

function lastToolResult(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "toolResult");
  return (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("mcp", () => {
  let dir: string;
  let nudge: Nudge | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-mcp-"));
    process.env.NUDGE_MCP_TEST_TOKEN = "t0ken";
    process.env.NUDGE_MCP_TEST_SECRET = "must-not-pass";
  });
  afterEach(async () => {
    await nudge?.close(context);
    nudge = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function open(servers: Record<string, unknown>) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const requests: ModelContext[] = [];
    const outputs: string[] = [];
    nudge = await createNudge(
      {
        database: join(dir, "a.sqlite"),
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [{ extension: mcp, settings: { servers } }],
      },
      context,
    );
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => (r: ModelContext) => {
      requests.push(r);
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    };
    const done = (r: ModelContext) => {
      requests.push(r);
      outputs.push(lastToolResult(r));
      return fauxAssistantMessage([fauxText("Done.")]);
    };
    const say = async (text: string) => {
      const settled = await (await nudge!.submit(LOBBY, { text, author }, context)).wait(context);
      if (settled.status !== "done") throw new Error(JSON.stringify(settled));
    };
    return { faux, requests, outputs, call, done, say, nudge };
  }

  it("names tools and fills in variables", () => {
    expect(toolName("git-hub", "list.issues")).toBe("mcp__git-hub__list_issues");
    expect(toolName("s", "x".repeat(80))).toHaveLength(64);
    expect(fillVariables("Bearer ${NUDGE_MCP_TEST_TOKEN}", process.env)).toBe("Bearer t0ken");
    expect(() => fillVariables("${NUDGE_NOPE}", process.env)).toThrow("$NUDGE_NOPE is not set");
  });

  it("offers a server's tools through tool_search, calls reads at once and asks for writes", async () => {
    const { faux, requests, outputs, call, done, say, nudge } = await open({
      fake: { command: process.execPath, args: [FAKE], env: { TOKEN: "${NUDGE_MCP_TEST_TOKEN}" } },
    });
    faux.setResponses([
      call("tool_search", { query: "look up a word" }),
      call(toolName("fake", "lookup"), { word: "fjord" }),
      done,
    ]);
    await say("What is a fjord?");
    const first = current(requests[0]);
    expect(first.tools).toContain("tool_search");
    expect(first.tools).not.toContain("mcp__fake__lookup");
    expect(first.prompt).toContain("- fake: lookup, save, env, pid, picture");
    expect(current(requests[1]).tools).toContain("mcp__fake__lookup");
    expect(outputs.at(-1)).toBe("fjord: a word. Call Ann on ⟦PHONE1⟧.");
    // The model saw the phone number only as a placeholder.
    expect(JSON.stringify(requests.at(-1))).not.toContain("987 65 432");

    faux.setResponses([
      call("tool_search", { query: "save note env pid picture", limit: 8 }),
      call(toolName("fake", "save"), { note: "Buy milk" }),
      done,
      done,
    ]);
    await say("Save a note: buy milk");
    expect(outputs.at(-1)).toBe("Waiting for approval a1.");
    const decided = await nudge.approvals.decide(
      LOBBY,
      "a1",
      { approve: true, by: { playerId: "owner", displayName: "Vegard" } },
      context,
    );
    expect(decided).toMatchObject({ status: "done", result: "Saved 1 notes." });
    // The room hears the outcome as a new turn.
    await nudge.harness.waitForIdle(context);

    faux.setResponses([
      call(toolName("fake", "env"), {}),
      done,
      call(toolName("fake", "picture"), {}),
      done,
    ]);
    await say("Show your environment");
    const env = JSON.parse(outputs.at(-1)!) as Record<string, string>;
    expect(env.TOKEN).toBe("t0ken");
    expect(env.NUDGE_MCP_TEST_SECRET).toBeUndefined();
    expect(env.PATH).toContain("/usr/bin");
    await say("Show the picture");
    expect(outputs.at(-1)).toBe("[an image, not shown]");
  });

  it("leaves out a server it can't start, and stops the programs it started at close", async () => {
    const { faux, outputs, call, done, say, nudge } = await open({
      fake: { command: process.execPath, args: [FAKE] },
      broken: { command: join(dir, "no-such-program") },
      unset: { command: process.execPath, args: [FAKE], env: { X: "${NUDGE_MCP_UNSET}" } },
    });
    faux.setResponses([
      call("tool_search", { query: "pid" }),
      call(toolName("fake", "pid"), {}),
      done,
    ]);
    await say("Which process?");
    const pid = Number(outputs.at(-1));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await nudge.close(context);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("refuses bad server settings", async () => {
    await expect(open({ "Bad Name": { command: "x" } })).rejects.toThrow("is not lower-case");
    await expect(open({ both: { command: "x", url: "http://x" } })).rejects.toThrow(
      "needs either command or url",
    );
  });
});
