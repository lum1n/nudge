import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { type Change, createNudge, requestApproval } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

async function open() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Noted.")]);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const nudge = await createNudge({ database: ":memory:", models, model }, context);
  const changes: Change[] = [];
  nudge.changes.subscribe((change) => changes.push(change));
  return { nudge, changes };
}

describe("changes", () => {
  it("reports every host-facing change after it is committed", async () => {
    const { nudge, changes } = await open();
    const ann = await nudge.players.invite("Ann", context);

    await nudge.rooms.createShared({ name: "Trip", members: [ann.player.id] }, context);
    await nudge.rooms.ensurePersonal(ann.player.id, context);
    expect(changes.splice(0)).toEqual([{ kind: "rooms" }, { kind: "rooms" }]);

    const fact = await nudge.memory.remember("trip", "Leaves on 3 May", context);
    expect(changes.splice(0)).toEqual([{ kind: "memory", roomId: "trip" }]);
    expect(await nudge.memory.forget("trip", fact.id, context)).toBe(true);
    expect(await nudge.memory.forget("trip", fact.id, context)).toBe(false);
    expect(changes.splice(0)).toEqual([{ kind: "memory", roomId: "trip" }]);

    const nudged = await nudge.nudges.schedule(
      "trip",
      { message: "Pack", fireAt: Date.now() + 3_600_000 },
      context,
    );
    expect(changes.splice(0)).toEqual([{ kind: "nudges", roomId: "trip" }]);
    expect(await nudge.nudges.cancel(nudged.id, context)).toBe(true);
    expect(changes.splice(0)).toEqual([{ kind: "nudges", roomId: "trip" }]);

    const approval = await nudge.harness.commit(
      (tx) =>
        requestApproval(
          tx,
          "trip",
          { extension: "mailer", kind: "send", summary: "Send a mail", payload: {} },
          Date.now(),
        ),
      context,
    );
    await nudge.approvals.decide(
      "trip",
      approval.id,
      { approve: false, by: { playerId: ann.player.id, displayName: "Ann" } },
      context,
    );
    expect(changes.splice(0)).toEqual([{ kind: "approvals", roomId: "trip" }]);

    await nudge.harness.waitForIdle(context);
    await nudge.close(context);
  });

  it("keeps going when a listener throws", async () => {
    const { nudge, changes } = await open();
    nudge.changes.subscribe(() => {
      throw new Error("boom");
    });
    await nudge.memory.remember("lobby", "Likes tea", context);
    expect(changes).toEqual([{ kind: "memory", roomId: "lobby" }]);
    await nudge.close(context);
  });
});
