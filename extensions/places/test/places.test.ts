import {
  BACKGROUND_CONTEXT,
  createNudge,
  type Geo,
  type ModelContext,
  type Nudge,
  type Player,
  type RoomEvent,
} from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlacesExtension, kindOf, nameOf, PlacesDoc } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const HOME = { latitude: 59.9127, longitude: 10.7461 };
const KIWI = { latitude: 59.915, longitude: 10.75 };

function textOf(content: ModelContext["messages"][number]["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(check: () => boolean | Promise<boolean>, timeout = 8_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Where the map was told people are. */
const followed: { latitude: number; longitude: number }[] = [];

const geo: Geo = {
  follow: async (point) => {
    followed.push(point);
    // Only around Oslo so far; abroad is on its way.
    return Math.abs(point.latitude - 59.9) < 1 ? "ready" : "fetching";
  },
  search: async (query) =>
    /storgata/i.test(query)
      ? [{ ...HOME, address: "Storgata 5, 0151 Oslo", city: "Oslo" }]
      : /oslo s/i.test(query)
        ? [{ latitude: 59.9111, longitude: 10.7528, name: "Oslo S", tag: "railway:station" }]
        : [],
  reverse: async () => ({ ...HOME, address: "Storgata 5, 0151 Oslo" }),
  nearby: async (tags, near, radiusKm) =>
    tags.includes("shop:supermarket") && Math.abs(near.latitude - KIWI.latitude) < radiusKm / 100
      ? [
          {
            ...KIWI,
            id: "N1",
            name: "Kiwi",
            address: "Torggata 2, 0181 Oslo",
            tag: "shop:supermarket",
          },
        ]
      : [],
  route: async (from, to) => ({
    meters: 1250,
    seconds: 900,
    steps: [
      { text: "Head north on Storgata", street: "Storgata", meters: 300, seconds: 200, at: from },
      {
        text: "Turn left onto Karl Johans gate",
        meters: 700,
        seconds: 500,
        at: { latitude: 59.93, longitude: 10.76 },
      },
      { text: "Arrive at Oslo S", meters: 0, seconds: 0, at: to },
    ],
  }),
};

describe("places", () => {
  let nudge: Nudge;
  let ann: Player;
  let events: RoomEvent[];
  /** Every request the model got, as JSON. */
  let seen: string[];
  /** What the model got when a reminder fired. */
  let fired: string[];
  let now: number;

  beforeEach(async () => {
    seen = [];
    fired = [];
    now = Date.UTC(2026, 9, 23, 12, 0);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    const answer = (request: ModelContext) => {
      seen.push(JSON.stringify(request));
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([fauxText(textOf(last.content))]);
      const message = request.messages.findLast((m) => m.role === "user");
      const text = message === undefined ? "" : textOf(message.content);
      if (text.includes("asked to be reminded then")) {
        fired.push(text);
        return fauxAssistantMessage([fauxText("Here's your reminder.")]);
      }
      if (/save storgata 5 as home/i.test(text))
        return call("save_place", { name: "home", address: "Storgata 5" });
      if (/when I get home/i.test(text))
        return call("remind_on_arrival", { where: "home", message: "Water the plants" });
      if (/grocery store/i.test(text))
        return call("remind_on_arrival", {
          where: "any grocery store",
          message: "Buy milk",
          repeat: "always",
        });
      if (/walk to oslo s/i.test(text))
        return call("route", { from: "home", to: "Oslo S", mode: "foot" });
      if (/forget home/i.test(text)) return call("forget_place", { place: "⟦PLACE:home⟧" });
      if (/a pharmacy near me/i.test(text)) return call("find_place", { query: "pharmacy" });
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 200 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        timeZone: "Europe/Oslo",
        now: () => now,
        extensions: [createPlacesExtension({ geo })],
      },
      context,
    );
    ann = (await nudge.players.invite("Ann", context)).player;
    const bo = (await nudge.players.invite("Bo", context)).player;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: [ann.id, bo.id] }, context);
    events = [];
    nudge.events.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  const say = async (text: string, room = "trip") => {
    const settled = await (
      await nudge.submit(room, { text, author: { playerId: ann.id, displayName: "Ann" } }, context)
    ).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
    const answer = events.findLast((e) => e.type === "answer" && e.cause === "message");
    return answer?.type === "answer" ? answer.text : "";
  };
  const at = (point: { latitude: number; longitude: number }) =>
    nudge.personal.update(ann.id, { location: { ...point, place: "Somewhere" } }, context);
  const fires = async () => {
    const room = await nudge.conversation("trip", context);
    const entries = (await room.entries({ order: "ascending" }, 500, undefined, context)).items;
    return entries.filter((e) => e.kind === "nudge.fire");
  };
  const route = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const found = nudge.extensionRoute("places", method, path.split("?")[0]!);
    if (found === undefined) throw new Error(`no route ${path}`);
    const response = await found.route.handle(
      new Request(`https://x.example/v1/a/nudge/ext/places${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { player: ann, admin: false, params: found.params, context },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("saves a place as ⟦PLACE:home⟧ and reminds once on getting there, privately", async () => {
    expect(await say("Save Storgata 5 as home")).toContain("⟦PLACE:home⟧");
    expect(nudge.showTo(ann.id, "⟦PLACE:home⟧")).toBe("Storgata 5, 0151 Oslo");
    expect(await say("Remind me when I get home to water the plants")).toContain("Reminder a1");

    await at({ latitude: 59.95, longitude: 10.8 });
    expect(await fires()).toHaveLength(0);
    await at(HOME);
    await until(async () => (await fires()).length === 1);
    expect(fired[0]).toContain("Ann just got to ⟦PLACE:home⟧");
    expect(fired[0]).toContain("Water the plants");
    // Ann doesn't share where she is in the trip room: Bo doesn't hear she got home.
    expect((await fires())[0]!.data).toMatchObject({
      source: "arrival",
      privateTo: { playerId: ann.id },
    });

    // Once: leaving and coming back says nothing more.
    await at({ latitude: 59.95, longitude: 10.8 });
    await at(HOME);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await fires()).toHaveLength(1);
    expect((await nudge.harness.snapshot(PlacesDoc, ann.id, context))!.reminders).toEqual([]);

    // Once saved, the model never sees the address, not even in the message that gave it, nor
    // any coordinates. Only the very first request, before the place existed, had it.
    const all = seen.slice(1).join("\n");
    expect(all).not.toMatch(/Storgata 5|59\.9\d|10\.7\d/);
    expect(all).toContain("⟦PLACE:home⟧");
  });

  it("says a reminder in the open where she shares her location", async () => {
    await nudge.personal.shareLocation(ann.id, "trip", true, context);
    await say("Save Storgata 5 as home");
    await say("Remind me when I get home to water the plants");
    await at(HOME);
    await until(async () => (await fires()).length === 1);
    expect((await fires())[0]!.data).not.toHaveProperty("privateTo");
  });

  it("watches the nearest grocery stores on the phone, and reminds there an hour apart", async () => {
    await say("Remind me to buy milk at any grocery store");
    const regions = await route(
      "GET",
      `/regions?lat=${KIWI.latitude + 0.002}&lon=${KIWI.longitude}`,
    );
    expect(regions.body).toMatchObject({
      regions: [{ id: "k:N1", latitude: KIWI.latitude, longitude: KIWI.longitude, radius: 80 }],
      refresh: { latitude: KIWI.latitude + 0.002 },
    });

    expect((await route("POST", "/events", { regionId: "k:N1", event: "enter" })).body).toEqual({
      fired: 1,
    });
    await until(() => fired.length === 1);
    expect(fired[0]).toMatch(/got to a grocery store, Kiwi \(⟦PLACE:kiwi⟧\)/);
    expect(nudge.showTo(ann.id, "⟦PLACE:kiwi⟧")).toBe("Torggata 2, 0181 Oslo");

    // Within the hour, not again; after it, again.
    await route("POST", "/events", { regionId: "k:N1", event: "exit" });
    expect((await route("POST", "/events", { regionId: "k:N1", event: "enter" })).body).toEqual({
      fired: 0,
    });
    now += 61 * 60_000;
    expect((await route("POST", "/events", { regionId: "k:N1", event: "enter" })).body).toEqual({
      fired: 1,
    });
    expect((await route("POST", "/events", { regionId: "x", event: "sideways" })).status).toBe(400);
    expect(seen.join("\n")).not.toContain("Torggata");
  });

  it("gives routes without the streets near home, and forgets a place", async () => {
    await say("Save Storgata 5 as home");
    const way = await say("How long to walk to Oslo S?");
    expect(way).toContain("From ⟦PLACE:home⟧ to Oslo S on foot: 15 min, 1.3 km");
    expect(way).toContain("Turn left onto Karl Johans gate");
    expect(way).not.toContain("Storgata");

    expect((await route("GET", "/places")).body).toMatchObject({
      places: [{ name: "home", placeholder: "⟦PLACE:home⟧", address: "Storgata 5, 0151 Oslo" }],
    });
    expect(await say("Forget home")).toContain("Forgot home");
    expect(nudge.showTo(ann.id, "⟦PLACE:home⟧")).toBe("⟦PLACE:home⟧");
    expect((await route("GET", "/places")).body).toMatchObject({ places: [] });
  });
});

describe("places abroad", () => {
  it("has the map follow people, and says when it doesn't cover them yet", async () => {
    followed.length = 0;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 20 }, () => (request: ModelContext) => {
        const last = request.messages.findLast((m) => m.role !== "system");
        if (last?.role === "toolResult")
          return fauxAssistantMessage([fauxText(textOf(last.content))]);
        return fauxAssistantMessage([fauxToolCall("find_place", { query: "pharmacy" })], {
          stopReason: "toolUse",
        });
      }),
    );
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [createPlacesExtension({ geo })],
      },
      context,
    );
    const ann = (await nudge.players.invite("Ann", context)).player;
    await nudge.rooms.ensurePersonal(ann.id, context);
    const events: RoomEvent[] = [];
    nudge.events.subscribe((event) => events.push(event));
    // In Lisbon, before the map has Portugal.
    const lisbon = { latitude: 38.72, longitude: -9.14 };
    await nudge.personal.update(ann.id, { location: lisbon }, context);
    await until(() => followed.length > 0);
    expect(followed[0]).toEqual(lisbon);
    await (
      await nudge.submit(
        `personal-${ann.id}`,
        { text: "a pharmacy near me", author: { playerId: ann.id, displayName: "Ann" } },
        context,
      )
    ).wait(context);
    const answer = events.findLast((e) => e.type === "answer");
    expect(answer?.type === "answer" ? answer.text : "").toContain(
      "doesn't cover that area yet: it is fetching it now",
    );
    await nudge.close(context);
  });
});

describe("words for places", () => {
  it("reads kinds of place loosely, and names placeholders plainly", () => {
    expect(kindOf("any grocery store")?.tags).toContain("shop:supermarket");
    expect(kindOf("the store")?.name).toBe("grocery store");
    expect(kindOf("Apotek")?.tags).toEqual(["amenity:pharmacy", "shop:chemist"]);
    expect(kindOf("Grandma's")).toBeUndefined();
    expect(nameOf("Mum's house")).toBe("mums-house");
    expect(nameOf("Hytta på Hvaler")).toBe("hytta-pa-hvaler");
    expect(nameOf("!!")).toBe("place");
  });
});
