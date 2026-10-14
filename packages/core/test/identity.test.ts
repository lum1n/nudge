import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNudge,
  DirectoryDoc,
  LOBBY,
  type NudgeOptions,
  PAIRING_TTL_MS,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

function setup(database: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  const answer = (text: string) => (request: ModelContext) => {
    requests.push(request);
    return fauxAssistantMessage(text);
  };
  const options: NudgeOptions = {
    database,
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
  };
  return { faux, requests, answer, options };
}

describe("players and rooms", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("invites players with tokens that survive a reopen and are stored hashed", async () => {
    const { options } = setup(join(dir, "a.sqlite"));
    const nudge = await createNudge(options, context);
    const ann = await nudge.players.invite("Ann Marie", context);
    const other = await nudge.players.invite("Ann Marie", context);
    expect(ann.player.id).toBe("ann-marie");
    expect(other.player.id).toBe("ann-marie-2");
    expect(ann.token).toMatch(/^nudge_/);
    const second = await nudge.players.issueToken(ann.player.id, context);
    expect(second.clientId).not.toBe(ann.clientId);
    await nudge.close(context);

    const reopened = await createNudge(options, context);
    expect(await reopened.players.authenticate(ann.token, context)).toEqual({
      player: ann.player,
      clientId: ann.clientId,
    });
    expect((await reopened.players.authenticate(second.token, context))?.player.id).toBe(
      "ann-marie",
    );
    expect(await reopened.players.authenticate("nudge_wrong", context)).toBeUndefined();
    const directory = await reopened.harness.snapshot(DirectoryDoc, context);
    expect(JSON.stringify(directory)).not.toContain(ann.token);
    await reopened.close(context);
  });

  it("lists a player's tokens and revokes one without the others", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const ann = await nudge.players.invite("Ann", context);
    const bo = await nudge.players.invite("Bo", context);
    const laptop = await nudge.players.issueToken(ann.player.id, context);

    const anns = await nudge.players.tokens(ann.player.id, context);
    expect(anns.map((t) => t.clientId)).toEqual([ann.clientId, laptop.clientId]);
    expect(JSON.stringify(anns)).not.toContain(ann.token);
    expect(await nudge.players.tokens(undefined, context)).toHaveLength(3);
    await expect(nudge.players.tokens("nobody", context)).rejects.toThrow('No player "nobody"');

    expect((await nudge.players.revoke(laptop.clientId, context)).playerId).toBe(ann.player.id);
    expect(await nudge.players.authenticate(laptop.token, context)).toBeUndefined();
    expect((await nudge.players.authenticate(ann.token, context))?.player.id).toBe("ann");
    expect((await nudge.players.authenticate(bo.token, context))?.player.id).toBe("bo");
    await expect(nudge.players.revoke(laptop.clientId, context)).rejects.toThrow(
      `No token for client "${laptop.clientId}"`,
    );
    await nudge.close(context);
  });

  it("trades a pairing code for a token once, within ten minutes", async () => {
    let now = 1_000_000;
    const { options } = setup(":memory:");
    const nudge = await createNudge({ ...options, now: () => now }, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const client = { name: "Nudge", platform: "ios" };

    const { code, expiresAt } = await nudge.players.pairingCode(ann.id, context);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(expiresAt).toBe(now + PAIRING_TTL_MS);
    // Typed by hand: lower case, no dash.
    const paired = await nudge.players.pair(code.toLowerCase().replace("-", ""), client, context);
    expect(paired?.player.id).toBe("ann");
    expect(await nudge.players.authenticate(paired!.token, context)).toEqual({
      player: ann,
      clientId: paired!.clientId,
    });
    const record = (await nudge.players.tokens(ann.id, context)).find(
      (t) => t.clientId === paired!.clientId,
    );
    expect(record?.client).toEqual(client);
    expect(await nudge.players.pair(code, client, context)).toBeUndefined();

    const late = await nudge.players.pairingCode(ann.id, context);
    now += PAIRING_TTL_MS;
    expect(await nudge.players.pair(late.code, client, context)).toBeUndefined();
    expect(await nudge.players.pair("0000-0000", client, context)).toBeUndefined();
    await expect(nudge.players.pairingCode("nobody", context)).rejects.toThrow(
      'No player "nobody"',
    );
    const directory = await nudge.harness.snapshot(DirectoryDoc, context);
    expect(Object.keys(directory?.pairing ?? {})).toEqual([]);
    await nudge.close(context);
  });

  it("makes the first player an admin, and others when marked", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    expect(await nudge.players.isAdmin(ann.id, context)).toBe(true);
    expect(await nudge.players.isAdmin(bo.id, context)).toBe(false);
    expect((await nudge.players.setAdmin(bo.id, true, context)).admin).toBe(true);
    expect(await nudge.players.isAdmin(bo.id, context)).toBe(true);
    await nudge.players.setAdmin(bo.id, false, context);
    await nudge.players.setAdmin(ann.id, false, context);
    expect(await nudge.players.isAdmin(bo.id, context)).toBe(false);
    expect(await nudge.players.isAdmin(ann.id, context)).toBe(true);
    expect(await nudge.players.isAdmin("nobody", context)).toBe(false);
    await nudge.close(context);
  });

  it("gives each player the lobby, their own room and the shared rooms they are in", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    const cy = (await nudge.players.invite("Cy", context)).player;

    const annsRoom = await nudge.rooms.ensurePersonal(ann.id, context);
    expect(await nudge.rooms.ensurePersonal(ann.id, context)).toEqual(annsRoom);
    const trip = await nudge.rooms.createShared(
      { name: "Trip!", members: [ann.id, bo.id] },
      context,
    );
    expect(trip.id).toBe("trip");
    await expect(
      nudge.rooms.createShared({ name: "x", members: ["nobody"] }, context),
    ).rejects.toThrow(/nobody/);

    const ids = async (playerId: string) =>
      (await nudge.rooms.list(context, playerId)).map((room) => room.id);
    expect(await ids(ann.id)).toEqual([LOBBY, "personal-ann", "trip"]);
    expect(await ids(bo.id)).toEqual([LOBBY, "trip"]);
    expect(await ids(cy.id)).toEqual([LOBBY]);
    expect(trip.conversationId).not.toBe(annsRoom.conversationId);
    await nudge.close(context);
  });

  it("tells the model who is in the room, by placeholder", async () => {
    const { faux, options, answer, requests } = setup(":memory:");
    faux.setResponses([answer("Hello both."), answer("Hi Ann.")]);
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: [ann.id, bo.id] }, context);
    const author = { playerId: ann.id, displayName: ann.displayName };
    await (await nudge.submit("trip", { text: "hi", author }, context)).wait(context);
    await nudge.rooms.ensurePersonal(ann.id, context);
    await (await nudge.submit("personal-ann", { text: "hi", author }, context)).wait(context);
    await nudge.close(context);

    const [shared, personal] = requests.map((request) => JSON.stringify(request));
    expect(shared).toContain("People who can read this conversation: ⟦NAME1⟧, ⟦NAME2⟧.");
    expect(personal).toContain("This is ⟦NAME1⟧'s personal conversation");
    expect(shared).not.toMatch(/\bAnn\b|\bBo\b/);
  });

  it("moves every room to a new model from the config", async () => {
    const database = join(dir, "a.sqlite");
    const { options } = setup(database);
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    await nudge.rooms.ensurePersonal(ann.id, context);
    await nudge.close(context);

    const model = { ...options.model, modelId: "other" };
    const reopened = await createNudge({ ...options, model }, context);
    for (const room of [LOBBY, "personal-ann"])
      expect((await (await reopened.conversation(room, context)).agent(context)).model).toEqual(
        model,
      );
    await reopened.close(context);
  });
});

describe("database lock", () => {
  it("refuses a second open of the same database until the first closes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-"));
    try {
      const { options } = setup(join(dir, "data", "a.sqlite"));
      const first = await createNudge(options, context);
      await expect(createNudge(options, context)).rejects.toThrow(/is open in process/);
      await first.close(context);
      await (await createNudge(options, context)).close(context);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
