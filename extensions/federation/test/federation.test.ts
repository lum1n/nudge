import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import { createApp } from "@nudge/server";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { federationExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const HOME = "https://home.example";
const AWAY = "https://away.example";

describe("federation", () => {
  const apps = new Map<string, Hono>();
  const errors: unknown[] = [];
  /** Requests between the two servers, without leaving the process. */
  const between: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const app = apps.get(url.origin);
    if (app === undefined) throw new Error(`No server at ${url.origin}`);
    return app.request(url.toString(), init);
  };
  let home: Nudge;
  let away: Nudge;
  let vegard: string;
  let ann: string;

  const open = async (name: string, server: string) => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const nudge = await createNudge(
      {
        name,
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: federationExtension({ fetch: between, report: (e) => errors.push(e) }),
            settings: { server },
          },
        ],
      },
      context,
    );
    apps.set(server, createApp({ assistants: new Map([[name, nudge]]) }));
    return nudge;
  };

  /** A request to `server`'s assistant, as `token`. */
  const call = async (
    server: string,
    method: string,
    path: string,
    { token, body }: { token?: string; body?: unknown } = {},
  ) => {
    const assistant = server === HOME ? "robin" : "team";
    const response = await between(`${server}/v1/a/${assistant}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: (text === "" ? undefined : JSON.parse(text)) as any };
  };

  beforeEach(async () => {
    errors.length = 0;
    home = await open("robin", HOME);
    away = await open("team", AWAY);
    vegard = (await home.players.invite("Vegard", context)).token;
    ann = (await away.players.invite("Ann", context)).token;
  });

  afterEach(async () => {
    await home.close(context);
    await away.close(context);
    apps.clear();
    expect(errors).toEqual([]);
  });

  const assertion = async () =>
    (
      await call(HOME, "POST", "/ext/federation/assert", {
        token: vegard,
        body: { server: AWAY, assistant: "team" },
      })
    ).json.assertion;

  it("lets someone an admin invited join from their home, once per assertion", async () => {
    const key = await call(HOME, "GET", "/ext/federation/key");
    expect(key.json).toMatchObject({ server: HOME, assistant: "robin" });

    const first = await assertion();
    expect(
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: first } }),
    ).toMatchObject({ status: 403, json: { error: "No invite for vegard@home.example/robin" } });
    expect(
      (
        await call(AWAY, "POST", "/ext/federation/invites", {
          token: ann,
          body: { address: "nobody" },
        })
      ).status,
    ).toBe(400);
    const invited = await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    expect(invited).toMatchObject({
      status: 201,
      json: {
        invite: { address: "vegard@home.example/robin", by: "ann" },
        link: "nudge://join?server=https%3A%2F%2Faway.example&assistant=team",
      },
    });

    const joined = await call(AWAY, "POST", "/ext/federation/join", {
      body: { assertion: first },
    });
    expect(joined).toMatchObject({
      status: 201,
      json: {
        player: { id: "vegard", displayName: "Vegard", address: "vegard@home.example/robin" },
      },
    });
    const token = joined.json.token as string;
    expect((await call(AWAY, "GET", "/me", { token })).json.player).toEqual({
      id: "vegard",
      displayName: "Vegard",
      address: "vegard@home.example/robin",
    });
    // The invite is used up, and so is the assertion.
    expect((await call(AWAY, "GET", "/ext/federation/invites", { token: ann })).json).toEqual({
      invites: [],
    });
    expect(
      (await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: first } })).status,
    ).toBe(401);
    // Coming back, such as from a second device, needs no new invite.
    const again = await call(AWAY, "POST", "/ext/federation/join", {
      body: { assertion: await assertion() },
    });
    expect(again).toMatchObject({ status: 201, json: { player: { id: "vegard" } } });
    expect(again.json.token).not.toBe(token);
    // A guest can't be vouched for by the assistant they visit.
    expect(
      (
        await call(AWAY, "POST", "/ext/federation/assert", {
          token,
          body: { server: HOME, assistant: "robin" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(HOME, "GET", "/ext/federation/memberships", { token: vegard })).json,
    ).toEqual({
      memberships: [{ server: AWAY, assistant: "team", since: expect.any(Number) }],
    });
  });

  it("refuses assertions the home didn't sign, or for another assistant", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    const signed = await assertion();
    const claim = JSON.parse(Buffer.from(signed.payload, "base64url").toString());
    const forged = {
      ...signed,
      payload: Buffer.from(
        JSON.stringify({ ...claim, profile: { displayName: "Mallory" } }),
      ).toString("base64url"),
    };
    expect(
      (await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: forged } })).status,
    ).toBe(401);
    const elsewhere = (
      await call(HOME, "POST", "/ext/federation/assert", {
        token: vegard,
        body: { server: "https://third.example", assistant: "team" },
      })
    ).json.assertion;
    expect(
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: elsewhere } }),
    ).toMatchObject({ status: 400, json: { error: "Not for this assistant" } });
    expect(
      (
        await call(HOME, "POST", "/ext/federation/assert", {
          token: vegard,
          body: { server: "http://10.0.0.1", assistant: "team" },
        })
      ).status,
    ).toBe(400);
  });

  it("sends a changed profile to every assistant the person joined", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } });

    await call(HOME, "PATCH", "/me/profile", {
      token: vegard,
      body: { displayName: "Vegard S", timeZone: "Europe/Oslo", extensions: {} },
    });
    await expect
      .poll(() => away.profiles.get("vegard", context))
      .toEqual({ displayName: "Vegard S", timeZone: "Europe/Oslo" });

    // An assistant that no longer knows them is dropped from their memberships.
    await call(HOME, "POST", "/ext/federation/assert", {
      token: vegard,
      body: { server: AWAY, assistant: "gone" },
    });
    await call(HOME, "PATCH", "/me/profile", { token: vegard, body: { language: "nb" } });
    await expect
      .poll(async () => (await away.profiles.get("vegard", context))?.language)
      .toBe("nb");
    await expect
      .poll(
        async () =>
          (await call(HOME, "GET", "/ext/federation/memberships", { token: vegard })).json
            .memberships.length,
      )
      .toBe(1);
  });
});
