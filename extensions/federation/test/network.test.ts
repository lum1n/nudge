import { createServer } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Api, ApiError, memoryTokens, ServerApi } from "@nudge/client";
import {
  type Assistants,
  createNudge,
  type Nudge,
  ServerIdentity,
  ServerKeys,
  ServerOwners,
} from "@nudge/core";
import { type RunningServer, type ServerControl, serveNudge } from "@nudge/server";
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

  /**
   * An assistant behind a real HTTP server, its federation reaching others with `fetch`; with
   * `owners`, the server's own API too.
   */
  const start = async (name: string, owners?: ServerOwners) => {
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
    const assistants = new Map([[name, nudge]]);
    const server: ServerControl | undefined =
      owners === undefined
        ? undefined
        : {
            assistants: { running: assistants, list: async () => [] } as unknown as Assistants,
            keys: new ServerKeys(undefined, () => []),
            owners,
            identity: new ServerIdentity(undefined),
            backupBeforeDelete: async () => "",
            testKey: async () => {},
            backupKey: async () => Buffer.alloc(32),
          };
    servers.push(
      await serveNudge({ assistants, port, ...(server === undefined ? {} : { server }) }),
    );
    return { nudge, url, assistants };
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
    // A guest's address is their home's.
    expect((await there.memberships()).address).toBe(address);
    await vegard.leave(place);
    expect((await vegard.memberships()).memberships).toEqual([]);
    // Leaving at home signs them out there.
    await expect
      .poll(() =>
        there.me().then(
          () => 200,
          (error: ApiError) => error.status,
        ),
      )
      .toBe(401);
    await expect(vegard.leave(place)).rejects.toEqual(new ApiError(404, "No such membership"));
  });

  it("keeps the servers someone owns at home, and signs them in there from any device", async () => {
    const home = await start("robin");
    const owners = new ServerOwners(undefined);
    const away = await start("team", owners);
    const other = await start("crew", new ServerOwners(undefined));
    const vegard = new Api({
      server: home.url,
      assistant: "robin",
      tokens: memoryTokens((await home.nudge.players.invite("Vegard", context)).token),
    });
    const ann = await away.nudge.players.invite("Ann", context);
    const asAnn = new ServerApi({
      server: away.url,
      tokens: memoryTokens(owners.issue(owners.add("team", ann.player.id).id).token),
    });
    const address = `vegard@${home.url}/robin`;
    const client = { name: "test", platform: "node" };
    const signIn = async (assertion: Awaited<ReturnType<Api["ownerAssertion"]>>) => {
      const tokens = memoryTokens();
      const session = await new ServerApi({ server: away.url, tokens }).signInFromHome(
        assertion,
        client,
      );
      expect(tokens.get()).toBe(session.token);
      return session;
    };
    const status = (work: Promise<unknown>) =>
      work.then(
        () => 200,
        (error: ApiError) => error.status,
      );

    // The list, kept once per server, with a trailing slash or not.
    expect(await vegard.ownedServers()).toEqual([]);
    const since = (await vegard.addOwnedServer(`${away.url}/`))[0]!.since;
    expect(await vegard.addOwnedServer(away.url)).toEqual([{ server: away.url, since }]);
    expect(await vegard.ownedServers()).toEqual([{ server: away.url, since }]);

    // Not an owner there yet; no membership is made.
    expect(await status(signIn(await vegard.ownerAssertion(away.url)))).toBe(403);
    expect((await vegard.memberships()).memberships).toEqual([]);

    // Made an owner by their address, with their home's keys pinned: no assistant there needed.
    const added = await asAnn.addOwnerAt(address);
    expect(added).toEqual({ id: expect.any(String), address, addedAt: expect.any(Number) });
    expect(await asAnn.addOwnerAt(address)).toEqual(added);

    const assertion = await vegard.ownerAssertion(away.url);
    const session = await signIn(assertion);
    expect(session.owner).toEqual(added);
    expect(
      (await new ServerApi({ server: away.url, tokens: memoryTokens(session.token) }).info()).owner,
    ).toEqual(added);
    // Once only, and only on the server it was sealed for.
    expect(await status(signIn(assertion))).toBe(401);
    expect(await status(signIn(await vegard.ownerAssertion(other.url)))).toBe(401);
    // A join assertion is no owner assertion.
    const place = { server: away.url, assistant: "team" };
    expect(await status(signIn(await vegard.vouchFor(place)))).toBe(401);

    // Joined there, then the assistant deleted: they are still its owner.
    await new Api({ ...place, tokens: memoryTokens(ann.token) }).invite(address);
    await new Api({ ...place, tokens: memoryTokens() }).join(await vegard.vouchFor(place));
    await away.nudge.retire(context);
    away.assistants.delete("team");
    owners.forgetAssistant("team");
    expect((await signIn(await vegard.ownerAssertion(away.url))).owner).toEqual(added);

    await vegard.removeOwnedServer(away.url);
    expect(await vegard.ownedServers()).toEqual([]);
    await expect(vegard.removeOwnedServer(away.url)).rejects.toEqual(
      new ApiError(404, "No such server"),
    );
  });
});
