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
  AdminOnly,
  AlreadyDecided,
  APPROVAL_ENTRY,
  ApprovalsDoc,
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  type Nudge,
  type NudgeOptions,
  requestApproval,
  roomOf,
  Type,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };

/**
 * A `send_mail` tool that only asks; its handler records what it was asked to send, and its
 * denial handler what it was refused.
 */
function mailer(sent: string[], refused: string[] = []) {
  return defineNudgeExtension({
    name: "mailer",
    version: "1",
    setup: ({ now }) => ({
      tools: [
        defineTool({
          name: "send_mail",
          description: "Send a mail",
          parameters: Type.Object({ to: Type.String() }),
          execute: async ({ to }, api, ctx) => {
            const room = await roomOf(api, api.conversationId, ctx);
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  {
                    extension: "mailer",
                    kind: "send",
                    summary: `Send a mail to ${to}`,
                    payload: { to },
                    adminOnly: to === "everyone@example.com",
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
        send: async (payload) => {
          const { to } = payload as { to: string };
          if (to === "nobody") throw new Error("No such address");
          sent.push(to);
          return { text: `Sent to ${to}.` };
        },
      },
      denials: {
        send: async (payload) => {
          refused.push((payload as { to: string }).to);
        },
      },
    }),
  });
}

function setup(sent: string[], refused: string[] = []) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  const reply = (message: ReturnType<typeof fauxAssistantMessage>) => (request: ModelContext) => {
    requests.push(request);
    return message;
  };
  const options: NudgeOptions = {
    database: ":memory:",
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    timeZone: "Europe/Oslo",
    extensions: [mailer(sent, refused)],
  };
  const askToSend = (to: string) => {
    faux.setResponses([
      reply(fauxAssistantMessage([fauxToolCall("send_mail", { to })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage("I asked for approval.")),
      reply(fauxAssistantMessage("Done, the room knows.")),
    ]);
  };
  return { options, requests, askToSend };
}

async function say(nudge: Nudge, text: string): Promise<void> {
  const settled = await (await nudge.submit(LOBBY, { text, author: by }, context)).wait(context);
  if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
}

/** The text of the latest input the room got from an approval. */
function lastInput(request: ModelContext | undefined): string {
  const message = request?.messages.findLast((m) => m.role === "user");
  const block = message?.content;
  return typeof block === "string"
    ? block
    : (block ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("approvals", () => {
  it("lets only an admin decide one that asks for an admin", async () => {
    const sent: string[] = [];
    const { options, askToSend } = setup(sent);
    const nudge = await createNudge(options, context);
    // The first player is an admin.
    const admin = (await nudge.players.invite("Vegard", context)).player;
    const ann = (await nudge.players.invite("Ann", context)).player;
    askToSend("everyone@example.com");
    await say(nudge, "Mail everyone");
    const [pending] = await nudge.approvals.list(LOBBY, context);
    expect(pending?.adminOnly).toBe(true);
    const asAnn = { playerId: ann.id, displayName: ann.displayName };
    await expect(
      nudge.approvals.decide(LOBBY, "a1", { approve: true, by: asAnn }, context),
    ).rejects.toThrow(AdminOnly);
    expect(sent).toEqual([]);
    const asAdmin = { playerId: admin.id, displayName: admin.displayName };
    expect(
      await nudge.approvals.decide(LOBBY, "a1", { approve: true, by: asAdmin }, context),
    ).toMatchObject({ status: "done" });
    expect(sent).toEqual(["everyone@example.com"]);
  });

  it("waits for a person, then runs the action and tells the room", async () => {
    const sent: string[] = [];
    const { options, requests, askToSend } = setup(sent);
    const nudge = await createNudge(options, context);
    askToSend("ann@example.com");
    await say(nudge, "Mail Ann");
    expect(sent).toEqual([]);
    const [pending] = await nudge.approvals.list(LOBBY, context);
    expect(pending).toMatchObject({
      id: "a1",
      extension: "mailer",
      kind: "send",
      // Stored with placeholders; the handler still gets the address.
      summary: "Send a mail to ⟦EMAIL1⟧",
      payload: { to: "⟦EMAIL1⟧" },
      status: "pending",
    });
    expect(nudge.showTo("ann", pending!.summary)).toBe("Send a mail to ann@example.com");

    const done = await nudge.approvals.decide(LOBBY, "a1", { approve: true, by }, context);
    expect(done).toMatchObject({
      status: "done",
      result: "Sent to ⟦EMAIL1⟧.",
      decidedBy: by,
    });
    expect(sent).toEqual(["ann@example.com"]);
    await nudge.harness.waitForIdle(context);
    // The room hears about it, and its e-mail address still goes out as a placeholder.
    expect(lastInput(requests.at(-1))).toMatch(
      /approved a1 \(Send a mail to ⟦EMAIL1⟧\) and it was done/,
    );
    const conversation = await nudge.conversation(LOBBY, context);
    const entries = await conversation.entries({}, 50, undefined, context);
    expect(entries.items.some((entry) => entry.kind === APPROVAL_ENTRY)).toBe(true);

    await expect(
      nudge.approvals.decide(LOBBY, "a1", { approve: true, by }, context),
    ).rejects.toThrow(AlreadyDecided);
    expect(sent).toEqual(["ann@example.com"]);
    await nudge.close(context);
  });

  it("gives an action only the private values its decider may see", async () => {
    const sent: string[] = [];
    const { options, askToSend } = setup(sent);
    const nudge = await createNudge(options, context);
    const placeholder = await nudge.protect("Storgata 1", "PRIVATE", { owner: "ann" });
    const ann = { playerId: "ann", displayName: "Ann" };
    const bo = { playerId: "bo", displayName: "Bo" };
    for (const id of ["a1", "a2"]) {
      askToSend(placeholder);
      await (await nudge.submit(LOBBY, { text: "Mail me", author: ann }, context)).wait(context);
      expect(await nudge.approvals.get(LOBBY, id, context)).toMatchObject({
        payload: { to: placeholder },
      });
    }
    await nudge.approvals.decide(LOBBY, "a1", { approve: true, by: bo }, context);
    await nudge.approvals.decide(LOBBY, "a2", { approve: true, by: ann }, context);
    expect(sent).toEqual([placeholder, "Storgata 1"]);
    await nudge.close(context);
  });

  it("does nothing when denied, and reports a failing action", async () => {
    const sent: string[] = [];
    const refused: string[] = [];
    const { options, requests, askToSend } = setup(sent, refused);
    const nudge = await createNudge(options, context);
    askToSend("bo@example.com");
    await say(nudge, "Mail Bo");
    const denied = await nudge.approvals.decide(LOBBY, "a1", { approve: false, by }, context);
    expect(denied.status).toBe("denied");
    await nudge.harness.waitForIdle(context);
    expect(lastInput(requests.at(-1))).toContain("denied approval a1");
    expect(sent).toEqual([]);
    // The extension hears of it, with the values put back.
    expect(refused).toEqual(["bo@example.com"]);

    askToSend("nobody");
    await say(nudge, "Mail nobody");
    const failed = await nudge.approvals.decide(LOBBY, "a2", { approve: true, by }, context);
    expect(failed).toMatchObject({ status: "failed", result: "No such address" });
    await nudge.harness.waitForIdle(context);
    expect(lastInput(requests.at(-1))).toContain("but it failed:\nNo such address");
    expect((await nudge.approvals.list(LOBBY, context)).map((a) => a.id)).toEqual(["a2", "a1"]);
    await nudge.close(context);
  });

  it("fails an approval whose extension is gone instead of running it", async () => {
    const sent: string[] = [];
    const { options, askToSend } = setup(sent);
    const nudge = await createNudge(options, context);
    askToSend("cy@example.com");
    await say(nudge, "Mail Cy");
    await nudge.reloadExtensions([]);
    const failed = await nudge.approvals.decide(LOBBY, "a1", { approve: true, by }, context);
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatch(/still installed/);
    await nudge.close(context);
  });

  it("never reruns an action that was running when the host stopped", async () => {
    const sent: string[] = [];
    const { options } = setup(sent);
    const nudge = await createNudge(options, context);
    // As if the host stopped between approving and finishing.
    await nudge.harness.commit(async (tx) => {
      await requestApproval(
        tx,
        LOBBY,
        { extension: "mailer", kind: "send", summary: "Send a mail", payload: { to: "x" } },
        0,
      );
      const state = await tx.doc(ApprovalsDoc, LOBBY, null);
      state.items[0]!.status = "approved";
    }, context);
    await nudge.approvals.recover(context);
    const [item] = await nudge.approvals.list(LOBBY, context);
    expect(item).toMatchObject({ status: "failed" });
    expect(item!.result).toMatch(/may or may not have happened/);
    expect(sent).toEqual([]);
    await nudge.close(context);
  });
});
