import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  createNudge,
  loadConfig,
  LOBBY,
  type Nudge,
  openAssistant,
} from "@nudge/core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@nudge/core/testing";
import type { RoomView } from "@nudge/protocol";
import { type RunningServer, serveNudge } from "@nudge/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatSession, openLocal, openRemote } from "../src/session.ts";

const context = BACKGROUND_CONTEXT;

/** The models every assistant the CLI opens runs on: a faux provider, set per test. */
const models = vi.hoisted(() => ({
  current: undefined as
    | { models: ReturnType<typeof createModels>; model: { provider: string; modelId: string } }
    | undefined,
}));

vi.mock("@nudge/core", async (original) => {
  const actual = await original<typeof import("@nudge/core")>();
  return {
    ...actual,
    openAssistant: (...[config, assistant, at, overrides]: Parameters<typeof openAssistant>) =>
      actual.openAssistant(config, assistant, at, { ...overrides, ...models.current }),
  };
});

/**
 * Ann, the first player and so an admin, and Bo, whose session it usually is; a value only Ann
 * sees and one only Bo sees; and nudges, one for the room and one only Ann sees.
 */
async function prepare(nudge: Nudge) {
  const ann = await nudge.players.invite("Ann", context);
  const bo = await nudge.players.invite("Bo", context);
  const anns = await nudge.protect("Ann's PIN 9876", "PRIVATE", { owner: "ann" });
  const bos = await nudge.protect("Bo's alarm 2222", "PRIVATE", { owner: "bo" });
  const later = Date.now() + 86_400_000;
  const shared = await nudge.nudges.schedule(LOBBY, { message: "Water", fireAt: later }, context);
  const private_ = await nudge.nudges.schedule(
    LOBBY,
    { message: "Ann's pills", fireAt: later, privateTo: { playerId: "ann", displayName: "Ann" } },
    context,
  );
  return {
    tokens: { ann: ann.token, bo: bo.token },
    anns,
    bos,
    shared: shared.id,
    private: private_.id,
  };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

/** One way to open Bo's (or Ann's) session in the lobby; resolves with it and what was prepared. */
type Opener = {
  open(
    onProblem: (message: string) => void,
    player?: "ann" | "bo",
  ): Promise<{ session: ChatSession; prepared: Prepared }>;
  close(): Promise<void>;
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-session-test-"));
  const faux = fauxProvider({ tokensPerSecond: 2000 });
  faux.setResponses([fauxAssistantMessage("Hello, Bo.")]);
  const created = createModels();
  created.setProvider(faux.provider);
  models.current = {
    models: created,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
  };
});

afterEach(async () => {
  models.current = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** The assistant's database, opened in this process as `nudge chat` does. */
function local(): Opener {
  return {
    async open(onProblem, player = "bo") {
      const config = join(dir, "nudge.json");
      await writeFile(
        config,
        JSON.stringify({ assistants: [{ name: "robin", database: "robin.sqlite" }] }),
      );
      const loaded = await loadConfig(config);
      const nudge = await openAssistant(loaded, loaded.assistants[0]!, context);
      const prepared = await prepare(nudge);
      await nudge.close(context);
      const session = await openLocal({ config, player, defaultName: "x", onProblem });
      return { session, prepared };
    },
    close: async () => {},
  };
}

/** The assistant behind `nudge serve`, through protocol v1. */
function remote(): Opener {
  let nudge: Nudge | undefined;
  let server: RunningServer | undefined;
  return {
    async open(onProblem, player = "bo") {
      nudge = await createNudge({ database: ":memory:", ...models.current! }, context);
      const prepared = await prepare(nudge);
      server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
      const session = await openRemote({
        url: server.url,
        token: prepared.tokens[player],
        onProblem,
      });
      return { session, prepared };
    },
    async close() {
      await server?.close();
      await nudge?.close(context);
    },
  };
}

describe.each([
  ["in this process", local],
  ["through a server", remote],
])("a chat session %s", (_, opener) => {
  let session: ChatSession;
  let prepared: Prepared;
  let problems: string[];
  let ending: Opener;

  beforeEach(async () => {
    problems = [];
    ending = opener();
    ({ session, prepared } = await ending.open((message) => problems.push(message)));
  });

  afterEach(async () => {
    await session.close();
    await ending.close();
    expect(problems).toEqual([]);
  });

  it("shows the lobby, and the answer to what it sends", async () => {
    const views: RoomView[] = [];
    const first = await session.watch((view) => views.push(view));
    expect(first.room).toMatchObject({ id: LOBBY, kind: "lobby" });
    await session.send("Hi", "followUp");
    await vi.waitFor(() =>
      expect(views.at(-1)?.timeline.at(-1)).toMatchObject({
        type: "answer",
        status: "done",
        parts: [{ type: "text", text: "Hello, Bo." }],
      }),
    );
  });

  it("remembers and forgets, and says when there is no such fact", async () => {
    const fact = await session.remember("The gate code is 4321");
    expect(fact.text).toBe("The gate code is 4321");
    await session.forget(fact.id);
    await expect(session.forget(fact.id)).rejects.toMatchObject({
      name: "UsageError",
      message: `No fact ${fact.id} here`,
    });
  });

  it("keeps Bo's private values his, and won't forget Ann's", async () => {
    const placeholder = await session.protect("Bo's door code 1111");
    const placeholders = async () =>
      (await session.privateValues()).map((value) => value.placeholder);
    expect(await placeholders()).toEqual([prepared.bos, placeholder]);
    await expect(session.forgetValue(prepared.anns)).rejects.toThrow(prepared.anns);
    await session.forgetValue(placeholder);
    expect(await placeholders()).toEqual([prepared.bos]);
    await expect(session.forgetValue(placeholder)).rejects.toMatchObject({
      name: "UsageError",
      message: `No value ${placeholder}`,
    });
  });

  it("cancels the room's nudge, but not one only Ann sees", async () => {
    await expect(session.cancelNudge(prepared.private)).rejects.toMatchObject({
      name: "UsageError",
      message: `No nudge ${prepared.private} here`,
    });
    await session.cancelNudge(prepared.shared);
    await expect(session.cancelNudge(prepared.shared)).rejects.toThrow(
      `No nudge ${prepared.shared} here`,
    );
  });

  it("says when there is no such extension", async () => {
    expect(await session.extensions()).toEqual([]);
    await expect(session.setExtension("nope", true)).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe.each([
  ["in this process", local],
  ["through a server", remote],
])("an admin's chat session %s", (_, opener) => {
  it("forgets another player's private value, as the server lets an admin", async () => {
    const problems: string[] = [];
    const ending = opener();
    const { session, prepared } = await ending.open((message) => problems.push(message), "ann");
    try {
      await session.forgetValue(prepared.bos);
      await expect(session.forgetValue(prepared.bos)).rejects.toThrow(`No value ${prepared.bos}`);
    } finally {
      await session.close();
      await ending.close();
    }
    expect(problems).toEqual([]);
  });
});
