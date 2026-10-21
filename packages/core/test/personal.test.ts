import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { createNudge, locationText, type NudgeOptions } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

function setup() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: string[] = [];
  const answer = (text: string) => (request: ModelContext) => {
    requests.push(JSON.stringify(request));
    return fauxAssistantMessage(text);
  };
  let now = Date.UTC(2026, 9, 21, 12, 0);
  const options: NudgeOptions = {
    database: ":memory:",
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    timeZone: "Europe/Oslo",
    now: () => now,
  };
  return { faux, requests, answer, options, tick: (ms: number) => (now += ms) };
}

const details = {
  fullName: "Ann Kristin Berg",
  email: "ann.berg@example.com",
  phone: "+47 912 34 567",
  address: "Storgata 5B, 0151 Oslo",
};

describe("personal details", () => {
  it("keeps them as the player's private values, apart from the profile", async () => {
    const { options } = setup();
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;

    expect(await nudge.personal.get(ann.id, context)).toEqual({});
    expect(await nudge.personal.get("nobody", context)).toBeUndefined();
    expect(await nudge.personal.update(ann.id, details, context)).toEqual(details);
    // Never in the profile, which a home sends to other assistants.
    expect(await nudge.profiles.get(ann.id, context)).toEqual({ displayName: "Ann" });
    const values = nudge.privateValues(ann.id);
    expect(values.map((value) => value.value).sort()).toEqual(Object.values(details).sort());
    expect(values.map((value) => value.kind).sort()).toEqual(["ADDRESS", "EMAIL", "NAME", "PHONE"]);
    expect(nudge.showTo(bo.id, "Mail ann.berg@example.com")).toMatch(/^Mail ⟦EMAIL\d+⟧$/);
    expect(nudge.showTo(ann.id, "Mail ann.berg@example.com")).toBe("Mail ann.berg@example.com");

    // Absent fields stay; null or an empty string clears one.
    expect(await nudge.personal.update(ann.id, { phone: null, address: " " }, context)).toEqual({
      fullName: details.fullName,
      email: details.email,
    });
    for (const bad of [
      { email: "not an address" },
      { phone: "call me" },
      { fullName: "x".repeat(201) },
      { location: { latitude: 91, longitude: 0 } },
      { location: { latitude: 0, longitude: Number.NaN } },
    ])
      await expect(nudge.personal.update(ann.id, bad, context)).rejects.toThrow();
    await nudge.close(context);
  });

  it("tells the model the placeholders in the player's own room and private turns only", async () => {
    const { faux, options, answer, requests } = setup();
    faux.setResponses([answer("Ok."), answer("Ok."), answer("Ok.")]);
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: [ann.id, bo.id] }, context);
    const personal = await nudge.rooms.ensurePersonal(ann.id, context);
    await nudge.personal.update(
      ann.id,
      { ...details, location: { latitude: 59.913868, longitude: 10.752245, place: "Oslo S" } },
      context,
    );
    const author = { playerId: ann.id, displayName: "Ann" };

    await (
      await nudge.submit(personal.id, { text: "fill in the form", author }, context)
    ).wait(context);
    await (await nudge.submit("trip", { text: "hei", author }, context)).wait(context);
    await (
      await nudge.submit("trip", { text: "where am I?", author, private: true }, context)
    ).wait(context);
    await nudge.close(context);

    const [own, shared, whisper] = requests;
    for (const request of [own, whisper]) {
      expect(request).toContain("personal details");
      expect(request).toMatch(/- E-mail: ⟦EMAIL\d+⟧/);
      expect(request).toMatch(/- Address: ⟦ADDRESS\d+⟧/);
      expect(request).toMatch(/- Where they are now: ⟦LOCATION\d+⟧ \(as of Wednesday 21 October/);
    }
    expect(shared).not.toContain("personal details");
    for (const request of requests) {
      for (const value of [...Object.values(details), "Ann", "59.91", "Oslo S"])
        expect(request).not.toContain(value);
    }
  });

  it("keeps one location, its placeholder while it moves only a little", async () => {
    const { options, tick } = setup();
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    const placeholder = () => nudge.privateValues(ann.id).filter((v) => v.kind === "LOCATION");

    const first = await nudge.personal.update(
      ann.id,
      { location: { latitude: 59.913868, longitude: 10.752245, place: "Oslo S" } },
      context,
    );
    expect(first.location).toEqual({
      text: "Oslo S (59.9139, 10.7522)",
      at: Date.UTC(2026, 9, 21, 12, 0),
    });
    const [kept] = placeholder();
    tick(60_000);
    const near = await nudge.personal.update(
      ann.id,
      { location: { latitude: 59.9142, longitude: 10.7525, place: "Oslo S" } },
      context,
    );
    expect(near.location?.text).toBe("Oslo S (59.9139, 10.7522)");
    expect(near.location?.at).toBe(Date.UTC(2026, 9, 21, 12, 1));
    expect(placeholder()).toEqual([kept]);

    const far = await nudge.personal.update(
      ann.id,
      { location: { latitude: 60.39299, longitude: 5.32415 } },
      context,
    );
    expect(far.location?.text).toBe("60.3930, 5.3242");
    // Where she was is forgotten, not kept as a history of places.
    expect(placeholder().map((v) => v.value)).toEqual(["60.3930, 5.3242"]);
    expect(nudge.redact(`at ${kept!.placeholder}`)).toBe(`at ${kept!.placeholder}`);
    expect(nudge.showTo(ann.id, kept!.placeholder)).toBe(kept!.placeholder);

    expect((await nudge.personal.update(ann.id, { location: null }, context)).location).toBe(
      undefined,
    );
    expect(placeholder()).toEqual([]);
    await nudge.close(context);
  });

  it("leaves a full name that is also a display name visible to the others", async () => {
    const { options } = setup();
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann Berg", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    expect((await nudge.personal.update(ann.id, { fullName: "ann berg" }, context)).fullName).toBe(
      "Ann Berg",
    );
    expect(nudge.privateValues(ann.id)).toEqual([]);
    expect(nudge.showTo(bo.id, "Ann Berg wrote")).toBe("Ann Berg wrote");
    await nudge.close(context);
  });

  it("drops a detail forgotten under hidden values", async () => {
    const { options } = setup();
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    await nudge.personal.update(ann.id, { email: details.email }, context);
    const [email] = nudge.privateValues(ann.id);
    await nudge.forgetValue(email!.placeholder, { playerId: ann.id });
    expect(await nudge.personal.get(ann.id, context)).toEqual({});
    await nudge.close(context);
  });

  it("writes a location with coordinates to about ten metres", () => {
    expect(locationText({ latitude: 59.913868, longitude: 10.752245 })).toBe("59.9139, 10.7522");
    expect(locationText({ latitude: -33.8688, longitude: 151.2093, place: " Sydney " })).toBe(
      "Sydney (-33.8688, 151.2093)",
    );
  });
});
