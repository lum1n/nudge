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
import { afterEach, describe, expect, it, vi } from "vitest";
import terminal from "../src/extension.ts";
import type { SandboxOptions } from "../src/sandbox.ts";

const context = BACKGROUND_CONTEXT;
const EMAIL = "kari.nordmann@example.no";

// Tests run where bubblewrap may not; sandbox.test.ts runs the real one.
const ran: { command: string; options: SandboxOptions }[] = [];
vi.mock("../src/sandbox.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox.ts")>()),
  sandboxProblem: () => undefined,
  runSandboxed: async (command: string, options: SandboxOptions) => {
    ran.push({ command, options });
    options.onOutput?.("contacts.csv\n");
    return {
      exitCode: 0,
      output: `contacts.csv\n${EMAIL}\n`,
      cut: 0,
      timedOut: false,
      aborted: false,
    };
  },
}));

function setup(settings: Record<string, unknown> = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  const reply = (message: ReturnType<typeof fauxAssistantMessage>) => (request: ModelContext) => {
    requests.push(structuredClone(request));
    return message;
  };
  const call = (command: string) =>
    reply(
      fauxAssistantMessage([fauxToolCall("run_command", { command })], { stopReason: "toolUse" }),
    );
  return {
    faux,
    requests,
    reply,
    call,
    open: () =>
      createNudge(
        {
          database: ":memory:",
          models,
          model: { provider: faux.provider.id, modelId: faux.getModel().id },
          extensions: [{ extension: terminal, settings }],
        },
        context,
      ),
  };
}

const json = (request: ModelContext | undefined) => JSON.stringify(request?.messages ?? []);

async function say(nudge: Nudge, text: string): Promise<void> {
  const author = { playerId: "owner", displayName: "Vegard" };
  const settled = await (await nudge.submit(LOBBY, { text, author }, context)).wait(context);
  if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
}

let nudge: Nudge | undefined;
afterEach(async () => {
  await nudge?.close(context);
  nudge = undefined;
  ran.length = 0;
});

describe("terminal extension", () => {
  it("runs a command in the room's workspace, and the model sees its output redacted", async () => {
    const { faux, requests, reply, call, open } = setup();
    faux.setResponses([
      call("ls && grep -r @ ."),
      reply(fauxAssistantMessage([fauxText("Found one.")])),
    ]);
    nudge = await open();
    await say(nudge, "Who is in my contacts?");

    expect(ran).toHaveLength(1);
    expect(ran[0]!.command).toBe("ls && grep -r @ .");
    expect(ran[0]!.options).toMatchObject({ network: false, timeoutMs: 60_000 });
    expect(ran[0]!.options.workspace).toMatch(/\/conversation-\d+$/);
    expect(json(requests[0])).toContain("It has no network");
    expect(json(requests[1])).toContain("⟦EMAIL1⟧");
    expect(json(requests[1])).toContain("(exit code 0)");
    for (const request of requests) expect(json(request)).not.toContain(EMAIL);
  });

  it("never runs what the policy refuses", async () => {
    const { faux, requests, reply, call, open } = setup({ deny: ["python3"] });
    faux.setResponses([
      call("sudo rm -rf /"),
      call("python3 -c 'print(1)'"),
      reply(fauxAssistantMessage([fauxText("I can't.")])),
    ]);
    nudge = await open();
    await say(nudge, "Clean up the machine");

    expect(ran).toHaveLength(0);
    expect(json(requests[1])).toContain("Not run: sudo never runs in the terminal");
    expect(json(requests[2])).toContain("Not run: python3 is not allowed here");
    expect(await nudge.approvals.list(LOBBY, context)).toHaveLength(0);
  });

  it("asks the room before deleting, and runs the command once approved", async () => {
    const { faux, requests, reply, call, open } = setup();
    faux.setResponses([
      call("rm -r old"),
      reply(fauxAssistantMessage([fauxText("It waits for your approval.")])),
    ]);
    nudge = await open();
    await say(nudge, "Delete the old folder");

    expect(ran).toHaveLength(0);
    const [pending] = await nudge.approvals.list(LOBBY, context);
    expect(pending).toMatchObject({ extension: "terminal", kind: "run", status: "pending" });
    expect(pending!.summary).toBe("In the terminal (rm deletes files): rm -r old");
    expect(json(requests[1])).toContain(`approval ${pending!.id}`);

    const decided = await nudge.approvals.decide(
      LOBBY,
      pending!.id,
      { approve: true, by: { playerId: "owner", displayName: "Vegard" } },
      context,
    );
    expect(decided).toMatchObject({ status: "done" });
    expect(decided.result).toContain("Ran `rm -r old`:\ncontacts.csv");
    expect(decided.result).not.toContain(EMAIL);
    expect(ran.map((r) => r.command)).toEqual(["rm -r old"]);
  });

  it("gives commands the network only when the settings do", async () => {
    const { faux, requests, reply, call, open } = setup({ network: true, timeoutSeconds: 5 });
    faux.setResponses([
      call("curl -s https://example.com"),
      reply(fauxAssistantMessage([fauxText("ok")])),
    ]);
    nudge = await open();
    await say(nudge, "Fetch it");
    expect(ran[0]!.options).toMatchObject({ network: true, timeoutMs: 5_000 });
    expect(json(requests[0])).toContain("It has the network.");
  });
});
