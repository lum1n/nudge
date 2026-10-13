import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNudge, MESSAGE_ENTRY, type NudgeOptions } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

function setup() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  const answer = (text: string) => (request: ModelContext) => {
    requests.push(request);
    return fauxAssistantMessage(text);
  };
  return {
    faux,
    models,
    requests,
    answer,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
  };
}

describe("Nudge", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("answers in the lobby and keeps it across a reopen", async () => {
    const { faux, models, model, answer, requests } = setup();
    faux.setResponses([answer("Paris.")]);
    const options: NudgeOptions = {
      database: join(dir, "assistant.sqlite"),
      models,
      model,
      displayName: "Robin",
    };

    const nudge = await createNudge(options, context);
    const submission = await nudge.submit(nudge.lobbyId, { text: "Capital of France?" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const lobbyId = nudge.lobbyId;
    await nudge.close(context);

    expect(requests[0]?.systemPrompt ?? JSON.stringify(requests[0]?.messages)).toContain(
      "You are Robin",
    );

    const reopened = await createNudge(options, context);
    expect(reopened.lobbyId).toBe(lobbyId);
    const lobby = await reopened.harness.conversation(lobbyId, context);
    const view = await lobby!.context(context);
    expect(view.messages.map((m) => m.role)).toEqual(expect.arrayContaining(["user", "assistant"]));
    await reopened.close(context);
  });

  it("tells the model who wrote a message and stores the author", async () => {
    const { faux, models, model, answer, requests } = setup();
    faux.setResponses([answer("Hi Ann.")]);
    const nudge = await createNudge({ database: ":memory:", models, model }, context);
    const author = { playerId: "p1", displayName: "Ann", clientId: "c1" };
    await (
      await nudge.submit(nudge.lobbyId, { text: "hello", author, requestId: "r1" }, context)
    ).wait(context);

    const users = requests[0]!.messages.filter((m) => m.role === "user");
    expect(JSON.stringify(users.at(-1))).toContain("⟦NAME1⟧: hello");
    const lobby = await nudge.harness.conversation(nudge.lobbyId, context);
    const entries = (await lobby!.entries({}, 50, undefined, context)).items;
    const message = entries.find((entry) => entry.kind === MESSAGE_ENTRY);
    expect(message?.data).toMatchObject({
      text: "hello",
      playerId: "p1",
      displayName: "Ann",
      clientId: "c1",
    });
    await nudge.close(context);
  });

  it("follows a model change in the config on reopen", async () => {
    const { faux, models, model } = setup();
    faux.setResponses([]);
    const database = join(dir, "a.sqlite");
    await (await createNudge({ database, models, model }, context)).close(context);
    const other = { ...model, modelId: "other" };
    const nudge = await createNudge(
      { database, models, model: other, instructions: "Speak Norwegian." },
      context,
    );
    const agent = await (await nudge.harness.conversation(nudge.lobbyId, context))!.agent(context);
    expect(agent.model).toEqual(other);
    expect(agent.instructions).toBe("Speak Norwegian.");
    await nudge.close(context);
  });
});
