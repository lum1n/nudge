import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  type Nudge,
  requestApproval,
  roomOf,
  type RoomEvent,
  Type,
} from "@nudge/core";
import { federationExtension } from "@nudge/ext-federation";
import { createApp } from "@nudge/server";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { PeersDoc, peersExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const HOME = "https://home.example";
const AWAY = "https://away.example";
const vegard = { playerId: "vegard", displayName: "Vegard" };
const ann = { playerId: "ann", displayName: "Ann" };

function textOf(message: ModelContext["messages"][number] | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(check: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A tool that books something only once someone in the room approves it. */
const booker = defineNudgeExtension({
  name: "booker",
  version: "0.0.1",
  setup: () => ({
    tools: [
      defineTool({
        name: "book",
        description: "Book a meeting.",
        parameters: Type.Object({ when: Type.String() }),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                { extension: "booker", kind: "book", summary: `Book ${args.when}`, payload: args },
                Date.now(),
              ),
            ctx,
          );
          return { output: [{ type: "text", text: `Asked my people (${approval.id}).` }] };
        },
      }),
    ],
    approvals: {
      book: async (payload) => ({ text: `Booked ${(payload as { when: string }).when}.` }),
    },
  }),
});

/** Whether Vegard wrote it himself: what the extension feeds the model repeats goals. */
const asked = (last: string, pattern: RegExp) => last.startsWith("Vegard (") && pattern.test(last);

type Script = (request: ModelContext, last: string) => ReturnType<typeof fauxAssistantMessage>;

describe("peers", { timeout: 30_000 }, () => {
  const apps = new Map<string, Hono>();
  const errors: unknown[] = [];
  /** Every sealed body sent to an inbox, by server, as it went. */
  const wire: { to: string; body: string }[] = [];
  /** Servers whose inbox takes messages and drops them. */
  const dropping = new Set<string>();
  const between: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/inbox")) {
      wire.push({ to: url.origin, body: String(init?.body) });
      if (dropping.has(url.origin)) return new Response(null, { status: 202 });
    }
    const app = apps.get(url.origin);
    if (app === undefined) throw new Error(`No server at ${url.origin}`);
    return app.request(url.toString(), init);
  };
  /** Every request each assistant's model got. */
  const requests = new Map<string, ModelContext[]>();
  let home: Nudge;
  let away: Nudge;
  let homeEvents: RoomEvent[];

  const open = async (
    name: string,
    displayName: string,
    server: string,
    script: Script,
    settings: Record<string, unknown>,
  ) => {
    const faux = fauxProvider();
    const seen: ModelContext[] = [];
    requests.set(name, seen);
    const answer = (request: ModelContext) => {
      seen.push(structuredClone(request));
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText(textOf(last))]);
      return script(request, textOf(request.messages.findLast((m) => m.role === "user")));
    };
    faux.setResponses(Array.from({ length: 300 }, () => answer));
    const models = createModels();
    models.setProvider(faux.provider);
    const nudge = await createNudge(
      {
        name,
        displayName,
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: federationExtension({ fetch: between, report: (e) => errors.push(e) }),
            settings: { server },
          },
          { extension: peersExtension({ report: (e) => errors.push(e) }), settings },
          { extension: booker },
        ],
      },
      context,
    );
    apps.set(server, createApp({ assistants: new Map([[name, nudge]]) }));
    return nudge;
  };

  const start = async (
    homeScript: Script,
    awayScript: Script,
    { homeSettings = {}, awaySettings = {} }: { homeSettings?: object; awaySettings?: object } = {},
  ) => {
    errors.length = 0;
    wire.length = 0;
    dropping.clear();
    home = await open("robin", "Robin", HOME, homeScript, homeSettings as Record<string, unknown>);
    away = await open("team", "Team", AWAY, awayScript, {
      offer: ["booker"],
      ...awaySettings,
    });
    await home.players.ensure(vegard.playerId, vegard.displayName, context);
    await away.players.ensure(ann.playerId, ann.displayName, context);
    homeEvents = [];
    home.events.subscribe((event) => homeEvents.push(event));
  };

  afterEach(async () => {
    await home?.close(context);
    await away?.close(context);
    apps.clear();
    expect(errors).toEqual([]);
  });

  const say = async (nudge: Nudge, text: string, author = vegard, room = LOBBY) => {
    const settled = await (await nudge.submit(room, { text, author }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };
  const pending = async (nudge: Nudge, room = LOBBY) =>
    (await nudge.approvals.list(room, context)).filter((a) => a.status === "pending");
  const stateOf = async (nudge: Nudge) => (await nudge.harness.snapshot(PeersDoc, context))!;

  /** Links the two, as their admins would: asked from home, agreed to away. */
  const link = async () => {
    await say(home, "Link with team");
    const asked = (await pending(home))[0]!;
    expect(asked).toMatchObject({ extension: "peers", kind: "link", adminOnly: true });
    await home.approvals.decide(LOBBY, asked.id, { approve: true, by: vegard }, context);
    await until(async () => (await pending(away)).length === 1);
    const incoming = (await pending(away))[0]!;
    expect(incoming.summary).toContain("Robin (home.example/robin)");
    expect(incoming.summary).toContain('"Family planning"');
    await away.approvals.decide(LOBBY, incoming.id, { approve: true, by: ann }, context);
    await until(async () => Object.values((await stateOf(home)).links)[0]?.status === "linked");
  };

  const linkScript: Script = (_request, last) =>
    asked(last, /Link with team/)
      ? fauxAssistantMessage(
          [
            fauxToolCall("link_assistant", {
              address: "away.example/team",
              note: "Family planning",
            }),
          ],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage([fauxText("Okay.")]);

  it("links two assistants once each side's admins agree", async () => {
    await start(linkScript, () => fauxAssistantMessage([fauxText("Okay.")]));
    await link();

    const there = Object.values((await stateOf(away)).links)[0]!;
    expect(there).toMatchObject({ status: "linked", displayName: "Robin" });
    const room = (await away.rooms.get(there.roomId!, context))!;
    expect(room).toMatchObject({ kind: "shared", name: "With Robin" });
    expect(room.members).toEqual(expect.arrayContaining(["ann", there.playerId]));
    expect((await away.players.get(there.playerId!, context))?.displayName).toBe(
      "Robin (assistant)",
    );
    expect(await away.players.isAdmin(there.playerId!, context)).toBe(false);
    // What it may use there is what `offer` names.
    const on = (await away.roomExtensions(room.id, context))
      .filter((extension) => extension.enabled)
      .map((extension) => extension.name);
    expect(on).toEqual(expect.arrayContaining(["peers", "booker"]));
    expect(on).not.toContain("federation");

    const here = Object.values((await stateOf(home)).links)[0]!;
    expect(here).toMatchObject({ status: "linked", displayName: "Team" });
    // The room it was asked from heard.
    await until(() => homeEvents.some((e) => e.type === "answer" && e.cause === "nudge"));
  });

  it("tells the room that asked when the other side says no", async () => {
    await start(linkScript, () => fauxAssistantMessage([fauxText("Okay.")]));
    await say(home, "Link with team");
    await home.approvals.decide(
      LOBBY,
      (await pending(home))[0]!.id,
      { approve: true, by: vegard },
      context,
    );
    await until(async () => (await pending(away)).length === 1);
    await away.approvals.decide(
      LOBBY,
      (await pending(away))[0]!.id,
      { approve: false, by: ann },
      context,
    );
    await until(async () => Object.keys((await stateOf(home)).links).length === 0);
    expect(Object.keys((await stateOf(away)).links)).toEqual([]);
    await until(() =>
      requests
        .get("robin")!
        .some((request) =>
          textOf(request.messages.findLast((m) => m.role === "user")).includes("turned down"),
        ),
    );
  });

  it("talks in a thread of a few rounds, and the room hears how it went", async () => {
    let replies = 0;
    let annsPhone = "";
    await start(
      (request, last) => {
        if (asked(last, /Link with team/)) return linkScript(request, last);
        if (asked(last, /when Ann is free/))
          return fauxAssistantMessage(
            [
              fauxToolCall("talk_to_assistant", {
                assistant: "Team",
                goal: "Find when Ann is free on Thursday",
                brief: "Vegard wants to meet her.",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.includes("Send your first message with say"))
          return fauxAssistantMessage(
            [fauxToolCall("say", { text: "When is Ann free Thursday?" })],
            {
              stopReason: "toolUse",
            },
          );
        if (last.includes("another assistant, says")) {
          replies++;
          return replies === 1
            ? fauxAssistantMessage([fauxToolCall("say", { text: "Does 14:00 work?" })], {
                stopReason: "toolUse",
              })
            : fauxAssistantMessage(
                [fauxToolCall("finish_thread", { summary: "Ann is free Thursday at 14:00." })],
                { stopReason: "toolUse" },
              );
        }
        if (last.includes("has ended")) return fauxAssistantMessage([fauxText(`Heard: ${last}`)]);
        return fauxAssistantMessage([fauxText("Okay.")]);
      },
      (_request, last) => {
        if (last.includes("When is Ann free"))
          return fauxAssistantMessage([fauxText(`After 13:00. Her phone is ${annsPhone}.`)]);
        if (last.includes("Does 14:00 work"))
          return fauxAssistantMessage([fauxText("Yes, 14:00 works.")]);
        return fauxAssistantMessage([fauxText("Okay.")]);
      },
    );
    // Ann's own number, private to her: it must not go to the other assistant.
    annsPhone = await away.protect("+47 912 34 567", "PHONE", { owner: "ann" });
    await link();

    await say(home, "Ask Team when Ann is free on Thursday");
    await until(() =>
      homeEvents.some(
        (e) => e.type === "answer" && e.cause === "nudge" && e.text.includes("14:00"),
      ),
    );

    const thread = Object.values((await stateOf(home)).threads)[0]!;
    expect(thread).toMatchObject({ direction: "out", status: "done", rounds: 2, sent: 2 });
    expect(thread.summary).toBe("Ann is free Thursday at 14:00.");
    expect(thread.messages.map((m) => m.from)).toEqual(["us", "them", "us", "them"]);
    const there = (await stateOf(away)).threads[thread.id]!;
    expect(there).toMatchObject({ direction: "in", status: "done", received: 2, sent: 2 });

    // The room on the other side shows it all, as from Robin's player.
    const theirs = Object.values((await stateOf(away)).links)[0]!;
    const { items } = await (
      await away.conversation(theirs.roomId!, context)
    ).entries({ order: "ascending" }, 100, undefined, context);
    const authored = items.filter((entry) => entry.kind === "nudge.message");
    expect(authored).toHaveLength(2);
    expect((authored[0]!.data as { playerId: string }).playerId).toBe(theirs.playerId);

    // The thread ran in a side conversation: the room saw only the outcome.
    const lobby = await home.conversation(LOBBY, context);
    const shown = (await lobby.entries({ order: "ascending" }, 200, undefined, context)).items;
    expect(JSON.stringify(shown)).not.toContain("Does 14:00 work");

    // What went to the other assistant was what Ann's assistant's peer may see.
    for (const request of requests.get("robin")!)
      expect(JSON.stringify(request)).not.toContain("912 34 567");
    expect(wire.some((sent) => sent.body.includes("912 34 567"))).toBe(false);
  });

  it("follows up when the other side's people approve something later", async () => {
    await start(
      (request, last) => {
        if (asked(last, /Link with team/)) return linkScript(request, last);
        if (asked(last, /book a meeting/i))
          return fauxAssistantMessage(
            [fauxToolCall("talk_to_assistant", { assistant: "l1", goal: "Book Thursday 14:00" })],
            { stopReason: "toolUse" },
          );
        if (last.includes("Send your first message with say"))
          return fauxAssistantMessage(
            [fauxToolCall("say", { text: "Please book Thursday 14:00." })],
            {
              stopReason: "toolUse",
            },
          );
        if (last.includes("followed up")) return fauxAssistantMessage([fauxText(`News: ${last}`)]);
        if (last.includes("another assistant, says"))
          return fauxAssistantMessage(
            [fauxToolCall("finish_thread", { summary: "They asked their people." })],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage([fauxText("Okay.")]);
      },
      (_request, last) => {
        if (last.includes("Please book"))
          return fauxAssistantMessage([fauxToolCall("book", { when: "Thursday 14:00" })], {
            stopReason: "toolUse",
          });
        if (last.includes("Booked Thursday"))
          return fauxAssistantMessage([fauxText("It's booked for Thursday 14:00.")]);
        return fauxAssistantMessage([fauxText("Okay.")]);
      },
    );
    await link();
    const room = Object.values((await stateOf(away)).links)[0]!.roomId!;
    await say(home, "Book a meeting with them");
    await until(async () => (await pending(away, room)).length === 1);
    await until(async () => Object.values((await stateOf(home)).threads)[0]?.status === "done");
    // Only the people there decide; the other assistant's player is no one who can.
    await away.approvals.decide(
      room,
      (await pending(away, room))[0]!.id,
      { approve: true, by: ann },
      context,
    );
    await until(() =>
      homeEvents.some(
        (e) => e.type === "answer" && e.cause === "nudge" && e.text.includes("booked"),
      ),
    );
  });

  it("ends a thread that gets no reply in time", async () => {
    await start(
      (request, last) => {
        if (asked(last, /Link with team/)) return linkScript(request, last);
        if (asked(last, /ask them/i))
          return fauxAssistantMessage(
            [fauxToolCall("talk_to_assistant", { assistant: "team", goal: "Ask something" })],
            { stopReason: "toolUse" },
          );
        if (last.includes("Send your first message with say"))
          return fauxAssistantMessage([fauxToolCall("say", { text: "Hello?" })], {
            stopReason: "toolUse",
          });
        if (last.includes("has ended")) return fauxAssistantMessage([fauxText(`Heard: ${last}`)]);
        return fauxAssistantMessage([fauxText("Okay.")]);
      },
      () => fauxAssistantMessage([fauxText("Okay.")]),
      { homeSettings: { replyHours: 0.0003 } },
    );
    await link();
    dropping.add(AWAY);
    await say(home, "Ask them something");
    await until(() =>
      homeEvents.some(
        (e) => e.type === "answer" && e.cause === "nudge" && e.text.includes("No reply came"),
      ),
    );
  });

  it("takes no thread from a link room, a replay, or past the hourly limit", async () => {
    let theirs = 0;
    await start(
      (request, last) => {
        if (asked(last, /Link with team/)) return linkScript(request, last);
        if (asked(last, /ask them/i))
          return fauxAssistantMessage(
            [fauxToolCall("talk_to_assistant", { assistant: "team", goal: `Ask ${theirs}` })],
            { stopReason: "toolUse" },
          );
        if (last.includes("Send your first message with say"))
          return fauxAssistantMessage([fauxToolCall("say", { text: "Relay this to someone." })], {
            stopReason: "toolUse",
          });
        if (last.includes("another assistant, says"))
          return fauxAssistantMessage([fauxToolCall("finish_thread", { summary: last })], {
            stopReason: "toolUse",
          });
        return fauxAssistantMessage([fauxText("Okay.")]);
      },
      (_request, last) => {
        if (last.includes("Relay this")) {
          theirs++;
          // No chains: a link room can't start threads of its own.
          return fauxAssistantMessage(
            [fauxToolCall("talk_to_assistant", { assistant: "Robin", goal: "Pass it on" })],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("Okay.")]);
      },
      { awaySettings: { maxThreadsPerHour: 1 } },
    );
    await link();
    await say(home, "Ask them");
    await until(async () => Object.values((await stateOf(home)).threads)[0]?.status === "done");
    const first = Object.values((await stateOf(home)).threads)[0]!;
    expect(first.summary).toContain("Threads are started from the assistant's own people's rooms");
    expect(Object.values((await stateOf(away)).threads)).toHaveLength(1);

    // The same message again changes nothing.
    const said = wire.filter((sent) => sent.to === AWAY).at(-2)!;
    const replayed = await between(`${AWAY}/v1/a/team/ext/federation/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: said.body,
    });
    // Taken as seen already: nothing is answered twice.
    expect(replayed.status).toBe(204);
    expect(theirs).toBe(1);

    // A second thread this hour is turned away: say fails, and the model hears so.
    await say(home, "Ask them again");
    await until(async () => Object.keys((await stateOf(home)).threads).length === 2);
    await until(async () =>
      (requests.get("robin") ?? []).some((request) =>
        JSON.stringify(request).includes("didn't take it"),
      ),
    );
    expect(theirs).toBe(1);
    // Federation reports what an inbox turned away.
    expect(errors).toEqual([new Error("https://away.example answered 429")]);
    errors.length = 0;
  });
});
