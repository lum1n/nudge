import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNudge } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

describe("createNudge", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("answers in the lobby and keeps it across a reopen", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("Paris.")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const options = {
      database: join(dir, "assistant.sqlite"),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
    };

    const nudge = await createNudge(options, context);
    const lobby = (await nudge.harness.conversation(nudge.lobbyId, context))!;
    const submission = await lobby.submit(
      { type: "input", content: "Capital of France?" },
      context,
    );
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("not answered");
    const answer = await lobby.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    expect(answer?.model?.[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Paris." }],
    });
    const lobbyId = nudge.lobbyId;
    await nudge.close(context);

    const reopened = await createNudge(options, context);
    expect(reopened.lobbyId).toBe(lobbyId);
    await reopened.close(context);
  });
});
