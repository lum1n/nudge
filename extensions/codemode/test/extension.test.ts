import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  type Nudge,
  Type,
} from "@nudge/core";
import { afterEach, describe, expect, it } from "vitest";
import codemode from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/** A room tool for scripts to call, whose output holds a phone number. */
const contacts = defineNudgeExtension({
  name: "contacts",
  version: "0.0.0",
  setup: () => ({
    tools: [
      defineTool({
        name: "lookup",
        description: "Look a person up.",
        parameters: Type.Object({ name: Type.String() }),
        execute: async ({ name }) => ({
          output: [{ type: "text", text: `${name}: call 987 65 432` }],
        }),
      }),
    ],
  }),
});

function lastToolResult(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "toolResult");
  return (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

function offered(request: ModelContext | undefined): string[] {
  const tools = new Set<string>();
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools];
}

describe("codemode", () => {
  let nudge: Nudge | undefined;
  afterEach(async () => {
    await nudge?.close(context);
    nudge = undefined;
  });

  async function run(code: string, settings: Record<string, unknown> = {}) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const requests: ModelContext[] = [];
    faux.setResponses([
      (r: ModelContext) => {
        requests.push(r);
        return fauxAssistantMessage([fauxToolCall("codemode", { code })], {
          stopReason: "toolUse",
        });
      },
      (r: ModelContext) => {
        requests.push(r);
        return fauxAssistantMessage([fauxText("Done.")]);
      },
    ]);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [contacts, { extension: codemode, settings }],
      },
      context,
    );
    const started = Date.now();
    const settled = await (await nudge.submit(LOBBY, { text: "go" }, context)).wait(context);
    expect(settled.status).toBe("done");
    return { requests, output: lastToolResult(requests.at(-1)!), ms: Date.now() - started };
  }

  it("runs a script that calls the room's tools, and the model sees the output redacted", async () => {
    const { requests, output } = await run(
      'const found = []; for (const name of ["Ann", "Bo"]) found.push(await tools.lookup({ name })); text(found.join("\\n"));',
    );
    expect(offered(requests[0])).toContain("codemode");
    expect(offered(requests[0])).not.toContain("pi.codemode.models.classify");
    expect(output).toContain("Ann: call ⟦PHONE1⟧");
    expect(output).toContain("Bo: call ⟦PHONE1⟧");
    expect(JSON.stringify(requests)).not.toContain("987 65 432");
  });

  it("stops a script that never ends at the deadline", async () => {
    const { output, ms } = await run("while (true) {}", { timeoutSeconds: 1 });
    expect(output.toLowerCase()).toMatch(/timed out|deadline|timeout/);
    expect(ms).toBeLessThan(10_000);
  });

  it("has no network, files or environment", async () => {
    const { output } = await run(
      'text([typeof fetch, typeof process, typeof require, typeof setTimeout].join(","));',
    );
    expect(output).toContain("undefined,undefined,undefined,undefined");
  });
});
