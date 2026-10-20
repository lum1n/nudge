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
  addressOf,
  parseAddress,
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

  it("renames rooms for their members and admins, keeping their ids", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    const cy = (await nudge.players.invite("Cy", context)).player;
    await nudge.rooms.ensurePersonal(bo.id, context);
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: [bo.id, cy.id] }, context);
    const changes: string[] = [];
    nudge.changes.subscribe((change) => changes.push(change.kind));

    const renamed = await nudge.renameRoom("trip", "  Rome  ", context, { playerId: cy.id });
    expect(renamed).toMatchObject({ id: "trip", name: "Rome", members: [bo.id, cy.id] });
    expect((await nudge.rooms.get("trip", context))?.name).toBe("Rome");
    expect(changes).toEqual(["rooms"]);
    await nudge.renameRoom("personal-bo", "Bo's desk", context, { playerId: bo.id });
    await expect(
      nudge.renameRoom("personal-bo", "Mine", context, { playerId: cy.id }),
    ).rejects.toThrow(/members/);
    await expect(nudge.renameRoom(LOBBY, "Hall", context, { playerId: bo.id })).rejects.toThrow(
      /admin/,
    );
    // Ann, the first player, is an admin.
    await nudge.renameRoom(LOBBY, "Hall", context, { playerId: ann.id });
    await nudge.renameRoom("trip", "Paris", context, { playerId: ann.id });
    expect((await nudge.rooms.list(context)).map((room) => room.name)).toEqual([
      "Hall",
      "Bo's desk",
      "Paris",
    ]);
    await expect(nudge.renameRoom("trip", " ", context)).rejects.toThrow(/name/);
    await expect(nudge.renameRoom("nowhere", "X", context)).rejects.toThrow(/nowhere/);
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

  it("keeps a profile per player, and tells the model their time zones and languages", async () => {
    const { faux, options, answer, requests } = setup(":memory:");
    faux.setResponses([answer("Hei.")]);
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: [ann.id, bo.id] }, context);
    const changes: unknown[] = [];
    nudge.changes.subscribe((change) => changes.push(change));

    expect(await nudge.profiles.get(ann.id, context)).toEqual({ displayName: "Ann" });
    expect(await nudge.profiles.get("nobody", context)).toBeUndefined();
    const updated = await nudge.profiles.update(
      ann.id,
      { displayName: "Anna", timeZone: "Europe/Oslo", language: "nb", notifications: {} },
      context,
    );
    expect(updated).toEqual({
      displayName: "Anna",
      timeZone: "Europe/Oslo",
      language: "nb",
      notifications: {},
    });
    expect((await nudge.players.get(ann.id, context))?.displayName).toBe("Anna");
    expect(changes).toEqual([{ kind: "profile", playerId: ann.id }]);
    // Absent fields stay; null clears one.
    expect(
      await nudge.profiles.update(ann.id, { notifications: null, language: "nb-NO" }, context),
    ).toEqual({ displayName: "Anna", timeZone: "Europe/Oslo", language: "nb-NO" });
    for (const bad of [
      { timeZone: "Mars/Olympus" },
      { language: "not a tag" },
      { avatar: "https://example.com/me.png" },
      { avatar: `data:image/png;base64,${"A".repeat(100_000)}` },
      { displayName: " " },
    ])
      await expect(nudge.profiles.update(ann.id, bad, context)).rejects.toThrow();
    await nudge.profiles.update(bo.id, { timeZone: "America/New_York" }, context);

    const author = { playerId: ann.id, displayName: "Anna" };
    await (await nudge.submit("trip", { text: "hei", author }, context)).wait(context);
    await nudge.close(context);
    const [request] = requests.map((request) => JSON.stringify(request));
    expect(request).toContain(
      "⟦NAME3⟧: time zone Europe/Oslo, speaks Norwegian Bokmål (Norway).\\n" +
        "⟦NAME2⟧: time zone America/New_York.\\n" +
        "Answer each person in their language.",
    );
    expect(request).not.toContain("Anna");
  });

  it("reads and writes addresses", () => {
    const home = { server: "https://nudge.example.com", assistant: "robin", playerId: "vegard" };
    expect(addressOf(home)).toBe("vegard@nudge.example.com/robin");
    expect(parseAddress("vegard@nudge.example.com/robin")).toEqual(home);
    expect(parseAddress(" vegard@https://nudge.example.com/robin ")).toEqual(home);
    expect(parseAddress("ann@example.com/nudge/robin")).toEqual({
      server: "https://example.com/nudge",
      assistant: "robin",
      playerId: "ann",
    });
    expect(parseAddress("ann@localhost:8787/robin")?.server).toBe("http://localhost:8787");
    expect(addressOf(parseAddress("ann@localhost:8787/robin")!)).toBe(
      "ann@http://localhost:8787/robin",
    );
    for (const bad of ["vegard", "vegard@host", "Vegard@host/robin", "a@host/robin?x=1", "a@/r"])
      expect(parseAddress(bad)).toBeUndefined();
  });

  it("lets someone from another home join, once per home", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    await nudge.players.invite("Vegard", context);
    const home = { server: "https://other.example", assistant: "robin", playerId: "vegard" };
    const first = await nudge.players.addRoaming(home, "Vegard", context);
    expect(first.player).toMatchObject({ id: "vegard-2", displayName: "Vegard", home });
    expect(await nudge.players.isAdmin(first.player.id, context)).toBe(false);
    expect((await nudge.players.authenticate(first.token, context))?.player.id).toBe("vegard-2");
    // A second device of the same person gets a token for the same player.
    const again = await nudge.players.addRoaming(home, "Vegard S", context);
    expect(again.player.id).toBe("vegard-2");
    expect(again.token).not.toBe(first.token);
    expect((await nudge.players.byHome(home, context))?.id).toBe("vegard-2");
    expect(await nudge.players.byHome({ ...home, playerId: "ann" }, context)).toBeUndefined();
    await nudge.close(context);
  });

  it("binds a player who lives here to their home, once, so joining from it lands on them", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const vegard = await nudge.players.invite("Vegard", context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const home = { server: "https://other.example", assistant: "robin", playerId: "vegard" };
    const keys = { signingKey: "s", encryptionKey: "e" };
    const bound = await nudge.players.setHome(vegard.player.id, home, { keys }, context);
    expect(bound).toMatchObject({ id: "vegard", home, startedFrom: { keys } });
    await expect(
      nudge.players.setHome(vegard.player.id, { ...home, playerId: "v" }, { keys }, context),
    ).rejects.toThrow(/has a home already/);
    await expect(nudge.players.setHome(ann.id, home, { keys }, context)).rejects.toThrow(
      /Another player has that home/,
    );
    const joined = await nudge.players.addRoaming(home, "Vegard", context);
    expect(joined.player.id).toBe("vegard");
    expect(await nudge.players.isAdmin("vegard", context)).toBe(true);
    expect((await nudge.players.authenticate(vegard.token, context))?.player.id).toBe("vegard");
    await nudge.close(context);
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
