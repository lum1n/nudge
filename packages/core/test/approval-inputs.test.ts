import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  ApprovalsDoc,
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  MissingInputs,
  requestApproval,
  roomOf,
  Type,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };
const KEY = "sk_live_51Hc0ffeeC0ffeeC0ffee";

/** A `set_key` tool that asks for the key on the approval; its handler records what it got. */
function keeper(got: Record<string, string>[]) {
  return defineNudgeExtension({
    name: "keeper",
    version: "1",
    setup: ({ now }) => ({
      tools: [
        defineTool({
          name: "set_key",
          description: "Ask for a key",
          parameters: Type.Object({ name: Type.String() }),
          execute: async ({ name }, api, ctx) => {
            const room = await roomOf(api, api.conversationId, ctx);
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  {
                    extension: "keeper",
                    kind: "key",
                    summary: `Give ${name}`,
                    payload: { name },
                    inputs: [
                      { name: "value", label: name, secret: true },
                      { name: "note", label: "Note", secret: false, optional: true },
                    ],
                    clientAction: { type: "exe.new", name: "proj-1" },
                  },
                  now(),
                ),
              ctx,
            );
            return {
              output: [{ type: "text", text: `Waiting for approval ${approval.id}.` }],
              details: { approval: approval.id },
            };
          },
        }),
      ],
      approvals: {
        key: async (_payload, run) => {
          got.push({ ...run.inputs });
          // Careless on purpose: the room must still not see it.
          return { text: `Kept ${run.inputs.value}.` };
        },
      },
    }),
  });
}

async function setup(got: Record<string, string>[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  const reply = (message: ReturnType<typeof fauxAssistantMessage>) => (request: ModelContext) => {
    requests.push(request);
    return message;
  };
  faux.setResponses([
    reply(
      fauxAssistantMessage([fauxToolCall("set_key", { name: "STRIPE_KEY" })], {
        stopReason: "toolUse",
      }),
    ),
    reply(fauxAssistantMessage("I asked for it.")),
    reply(fauxAssistantMessage("It is set.")),
  ]);
  const nudge = await createNudge(
    {
      database: ":memory:",
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      timeZone: "Europe/Oslo",
      extensions: [keeper(got)],
    },
    context,
  );
  const settled = await (
    await nudge.submit(LOBBY, { text: "Set the Stripe key", author: by }, context)
  ).wait(context);
  expect(settled.status).toBe("done");
  return { nudge, requests };
}

describe("approvals with inputs", () => {
  it("keeps what they ask for and the client action, but no values", async () => {
    const { nudge } = await setup([]);
    const [pending] = await nudge.approvals.list(LOBBY, context);
    expect(pending).toMatchObject({
      inputs: [
        { name: "value", label: "STRIPE_KEY", secret: true },
        { name: "note", label: "Note", secret: false, optional: true },
      ],
      clientAction: { type: "exe.new", name: "proj-1" },
    });
    await nudge.close(context);
  });

  it("refuses an approval missing a required input, and leaves it pending", async () => {
    const got: Record<string, string>[] = [];
    const { nudge } = await setup(got);
    await expect(
      nudge.approvals.decide(LOBBY, "a1", { approve: true, by, inputs: { value: " " } }, context),
    ).rejects.toThrow(MissingInputs);
    expect(got).toEqual([]);
    expect((await nudge.approvals.get(LOBBY, "a1", context))?.status).toBe("pending");
    await nudge.close(context);
  });

  it("gives the values to the handler only, never to the room or the model", async () => {
    const got: Record<string, string>[] = [];
    const { nudge, requests } = await setup(got);
    const done = await nudge.approvals.decide(
      LOBBY,
      "a1",
      { approve: true, by, inputs: { value: KEY, stray: "dropped" } },
      context,
    );
    expect(got).toEqual([{ value: KEY }]);
    expect(done).toMatchObject({ status: "done", result: "Kept [secret]." });
    await nudge.harness.waitForIdle(context);
    expect(JSON.stringify(requests)).not.toContain(KEY);
    const stored = await nudge.harness.snapshot(ApprovalsDoc, LOBBY, context);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    const conversation = await nudge.conversation(LOBBY, context);
    const entries = await conversation.entries({}, 50, undefined, context);
    expect(JSON.stringify(entries)).not.toContain(KEY);
    await nudge.close(context);
  });

  it("asks for nothing when denied", async () => {
    const got: Record<string, string>[] = [];
    const { nudge } = await setup(got);
    const denied = await nudge.approvals.decide(LOBBY, "a1", { approve: false, by }, context);
    expect(denied.status).toBe("denied");
    expect(got).toEqual([]);
    await nudge.close(context);
  });
});
