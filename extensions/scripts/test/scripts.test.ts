import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
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
  readsOnly,
  Type,
} from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptsDoc, scriptsExtension, withArgs } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const ann = { playerId: "ann", displayName: "Ann" };

/** A site to read and a message to send; only the first reads. */
let sent: string[] = [];
const site = defineNudgeExtension({
  name: "site",
  version: "0.0.0",
  setup: () => ({
    tools: [
      readsOnly(
        defineTool({
          name: "listings",
          description: "List what is for sale.",
          parameters: Type.Object({ search: Type.String() }),
          execute: async ({ search }) => ({
            output: [{ type: "text", text: `${search}: 780 000 kr` }],
          }),
        }),
      ),
      defineTool({
        name: "send",
        description: "Send a message.",
        parameters: Type.Object({ to: Type.String() }),
        execute: async ({ to }) => {
          sent.push(to);
          return { output: [{ type: "text", text: "sent" }] };
        },
      }),
    ],
  }),
});

function lastToolResult(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "toolResult");
  return (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("scripts", () => {
  let nudge: Nudge;
  /** Tool calls the model makes, one per message it is sent. */
  let calls: { name: string; args: JsonObject }[];
  let results: string[];

  beforeEach(async () => {
    sent = [];
    calls = [];
    results = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult") {
        results.push(lastToolResult(request));
        return fauxAssistantMessage([fauxText("Done.")]);
      }
      const call = calls.shift()!;
      return fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 50 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [site, { extension: scriptsExtension, settings: { timeoutSeconds: 2 } }],
      },
      context,
    );
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  const ask = async (name: string, args: JsonObject, as: { private?: true } = {}) => {
    calls.push({ name, args });
    const message = as.private === undefined ? { text: "go" } : { text: "go", author: ann, ...as };
    const settled = await (await nudge.submit(LOBBY, message, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
    return results.at(-1)!;
  };
  const scripts = async () => (await nudge.harness.snapshot(ScriptsDoc, LOBBY, context))?.items;

  it("saves a script after a test run, and runs it again by name with args", async () => {
    const code =
      "const found = await tools.listings({ search: args.search ?? 'GLC' });\n" +
      "return { items: [{ key: 'a', text: found }] };";
    const saved = await ask("save_script", {
      name: "finn-glc",
      description: "GLC listings",
      code,
      test_args: { search: "GLC 2027" },
    });
    expect(saved).toContain("Saved script finn-glc");
    expect(saved).toContain("GLC 2027: 780 000 kr");
    expect((await scripts())?.[0]).toMatchObject({ name: "finn-glc", code, runs: 1 });

    const ran = await ask("run_script", { name: "finn-glc", args: { search: "EQE" } });
    expect(ran).toContain("EQE: 780 000 kr");
    expect((await scripts())?.[0]?.runs).toBe(2);
  });

  it("keeps tools that change things out of scripts", async () => {
    const saved = await ask("save_script", {
      name: "spam",
      description: "Sends",
      code: "await tools.send({ to: 'ann' }); return 'ok';",
    });
    expect(saved).toContain("Not saved");
    expect(sent).toEqual([]);
    expect(await scripts()).toBeUndefined();

    const listed = await ask("save_script", {
      name: "tools",
      description: "Lists the tools",
      code: "return Object.keys(tools).join(',');",
    });
    expect(listed).toContain("listings");
    expect(listed).not.toContain("send");
    expect(listed).not.toContain("script_exec");
  });

  it("refuses a script that fails or runs past its deadline", async () => {
    expect(
      await ask("save_script", { name: "slow", description: "x", code: "while (true) {}" }),
    ).toContain("Not saved");
    expect(
      await ask("save_script", { name: "Bad Name", description: "x", code: "return 1;" }),
    ).toContain("lower case");
  });

  it("keeps a private script's name to its owner", async () => {
    const code = "return 'mine';";
    await ask("save_script", { name: "mine", description: "Ann's", code }, { private: true });
    expect(
      await ask("save_script", { name: "mine", description: "x", code: "return 1;" }),
    ).toContain("is taken");
    expect(await ask("remove_script", { name: "mine" })).toContain("No script mine");
    expect(await scripts()).toMatchObject([{ name: "mine", code, privateTo: ann }]);

    expect(await ask("remove_script", { name: "mine" }, { private: true })).toContain("Removed");
    expect(await scripts()).toEqual([]);
  });

  it("won't replace a public script with a private one of its name", async () => {
    const code = "return 'ours';";
    await ask("save_script", { name: "ours", description: "Everyone's", code });
    expect(
      await ask(
        "save_script",
        { name: "ours", description: "Ann's", code: "return 'mine';" },
        { private: true },
      ),
    ).toContain("everyone here uses");
    expect(await scripts()).toMatchObject([{ name: "ours", code }]);
    expect((await scripts())?.[0]).not.toHaveProperty("privateTo");

    // In public it is replaced as before; a private script may be replaced in its owner's turns.
    expect(
      await ask("save_script", { name: "ours", description: "Everyone's", code: "return 2;" }),
    ).toContain("Replaced script ours");
    await ask("save_script", { name: "mine", description: "Ann's", code }, { private: true });
    expect(
      await ask(
        "save_script",
        { name: "mine", description: "Ann's", code: "return 3;" },
        { private: true },
      ),
    ).toContain("Replaced script mine");
    expect(await scripts()).toMatchObject([
      { name: "ours", code: "return 2;" },
      { name: "mine", code: "return 3;", privateTo: ann },
    ]);
  });

  it("puts args after an options line", () => {
    expect(withArgs("return args.a;", { a: 1 })).toBe('const args = {"a":1};\nreturn args.a;');
    expect(withArgs('// @options: {"timeout_ms":5}\nreturn 1;', undefined)).toBe(
      '// @options: {"timeout_ms":5}\nconst args = {};\nreturn 1;',
    );
  });
});
