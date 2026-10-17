import { createServer } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Api, ApiError, memoryTokens } from "@nudge/client";
import { createNudge, type Nudge } from "@nudge/core";
import { type RunningServer, serveNudge } from "@nudge/server";
import { afterEach, describe, expect, it } from "vitest";
import { federationExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/** A port nothing listens on, for a server that has to know its address before it starts. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });

describe("federation over the network", () => {
  const opened: Nudge[] = [];
  const servers: RunningServer[] = [];
  const errors: unknown[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const nudge of opened.splice(0)) await nudge.close(context);
    expect(errors).toEqual([]);
    errors.length = 0;
  });

  /** An assistant behind a real HTTP server, its federation reaching others with `fetch`. */
  const start = async (name: string) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
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
            extension: federationExtension({ report: (e) => errors.push(e) }),
            settings: { server: url },
          },
        ],
      },
      context,
    );
    opened.push(nudge);
    servers.push(await serveNudge({ assistants: new Map([[name, nudge]]), port }));
    return { nudge, url };
  };

  it("joins from home through the client, and manages the membership there", async () => {
    const home = await start("robin");
    const away = await start("team");
    const vegard = new Api({
      server: home.url,
      assistant: "robin",
      tokens: memoryTokens((await home.nudge.players.invite("Vegard", context)).token),
    });
    const ann = new Api({
      server: away.url,
      assistant: "team",
      tokens: memoryTokens((await away.nudge.players.invite("Ann", context)).token),
    });
    const address = `vegard@${home.url}/robin`;
    const { link } = await ann.invite(address);
    expect(link).toBe(`nudge://join?server=${encodeURIComponent(away.url)}&assistant=team`);
    expect((await ann.invites()).map((invite) => invite.address)).toEqual([address]);

    const place = { server: away.url, assistant: "team" };
    const tokens = memoryTokens();
    const there = new Api({ ...place, tokens });
    const joined = await there.join(await vegard.vouchFor(place));
    expect(joined.player).toEqual({ id: "vegard", displayName: "Vegard", address });
    expect(tokens.get()).toBe(joined.token);
    expect((await there.me()).player.address).toBe(address);
    expect(await ann.invites()).toEqual([]);

    expect(await vegard.memberships()).toEqual({
      address,
      memberships: [{ ...place, since: expect.any(Number), carryMemory: false }],
    });
    expect(await vegard.carryMemory(place, true)).toMatchObject({ ...place, carryMemory: true });
    await vegard.leave(place);
    expect((await vegard.memberships()).memberships).toEqual([]);
    // A guest's address is their home's.
    expect((await there.memberships()).address).toBe(address);
    await expect(vegard.leave(place)).rejects.toEqual(new ApiError(404, "No such membership"));
  });
});
