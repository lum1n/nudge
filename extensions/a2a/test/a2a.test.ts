import { AgentCard, GetTaskRequest, ListTasksRequest, SendMessageRequest, Task } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import {
  BACKGROUND_CONTEXT,
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  type ModelContext,
  type Nudge,
  requestApproval,
  roomOf,
  Type,
} from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { createApp } from "@nudge/server";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { A2ADoc, a2aExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const HOME = "https://home.example";
const AWAY = "https://away.example";
/** Where an outside agent listens for push notifications. */
const HOOKS = "https://hooks.example";

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

type Script = (request: ModelContext, last: string) => ReturnType<typeof fauxAssistantMessage>;

/** Away's assistant: answers when it is free, and books once its people agree. */
const awayScript: Script = (_request, last) => {
  if (/Booked Friday/.test(last)) return fauxAssistantMessage([fauxText("Friday is booked.")]);
  if (/Book Friday/.test(last))
    return fauxAssistantMessage([fauxToolCall("book", { when: "Friday" })], {
      stopReason: "toolUse",
    });
  if (/Ask your agents/.test(last))
    return fauxAssistantMessage([fauxToolCall("message_agent", { agent: "g2", text: "Hi" })], {
      stopReason: "toolUse",
    });
  if (/When are you free/.test(last))
    return fauxAssistantMessage([fauxText("Thursday after three works.")]);
  return fauxAssistantMessage([fauxText("Okay.")]);
};

describe("a2a", { timeout: 30_000 }, () => {
  const apps = new Map<string, Hono>();
  const errors: unknown[] = [];
  /** Push notifications outside agents got. */
  const hooks: { url: string; token: string | null; body: unknown }[] = [];
  const between: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === HOOKS) {
      const headers = new Headers(init?.headers);
      hooks.push({
        url: url.toString(),
        token: headers.get("X-A2A-Notification-Token"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(null, { status: 204 });
    }
    const app = apps.get(url.origin);
    if (app === undefined) throw new Error(`No server at ${url.origin}`);
    return input instanceof Request ? app.request(input) : app.request(url.toString(), init);
  };
  let home: Nudge;
  let away: Nudge;
  let homeAdmin: string;
  let awayAdmin: string;
  let vegard: { playerId: string; displayName: string };
  let ann: { playerId: string; displayName: string };

  const open = async (
    name: string,
    displayName: string,
    server: string,
    script: Script,
    settings: Record<string, unknown>,
  ) => {
    const faux = fauxProvider();
    const answer = (request: ModelContext) => {
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
            extension: a2aExtension({ fetch: between, report: (e) => errors.push(e) }),
            settings: { server, waitSeconds: 2, ...settings },
          },
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
    { homeSettings = {}, awaySettings = {} }: { homeSettings?: object; awaySettings?: object } = {},
  ) => {
    errors.length = 0;
    hooks.length = 0;
    home = await open("robin", "Robin", HOME, homeScript, homeSettings as Record<string, unknown>);
    away = await open("team", "Team", AWAY, awayScript, {
      offer: ["booker"],
      ...(awaySettings as Record<string, unknown>),
    });
    const v = await home.players.invite("Vegard", context);
    homeAdmin = v.token;
    vegard = { playerId: v.player.id, displayName: "Vegard" };
    const a = await away.players.invite("Ann", context);
    awayAdmin = a.token;
    ann = { playerId: a.player.id, displayName: "Ann" };
  };

  afterEach(async () => {
    await home?.close(context);
    await away?.close(context);
    apps.clear();
    expect(errors).toEqual([]);
  });

  /** A request to a server's assistant, as `token`. */
  const call = async (
    server: string,
    assistant: string,
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
  ) => {
    const response = await between(`${server}/v1/a/${assistant}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? undefined : JSON.parse(text) };
  };

  /** An admin on away lets an outside agent in; its token and card address. */
  const letIn = async (name = "Planner") => {
    const made = await call(AWAY, "team", "POST", "/ext/a2a/clients", awayAdmin, { name });
    expect(made.status).toBe(201);
    return made.json as { client: { id: string; roomId: string }; token: string; card: string };
  };

  /** The official SDK's client, as an outside agent with `token`. */
  const sdkClient = async (token: string) => {
    const fetchImpl: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return between(input, { ...init, headers });
    };
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: between }),
      }),
    );
    return factory.createFromUrl(`${AWAY}/v1/a/team/ext/a2a/`);
  };

  const send = (text: string, extra: Record<string, unknown> = {}) =>
    SendMessageRequest.fromJSON({
      message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] },
      ...extra,
    });

  const pending = async (nudge: Nudge, room: string) =>
    (await nudge.approvals.list(room, context)).filter((a) => a.status === "pending");

  const say = async (nudge: Nudge, text: string, author: typeof vegard, room = LOBBY) => {
    const settled = await (await nudge.submit(room, { text, author }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };

  const quiet: Script = () => fauxAssistantMessage([fauxText("Okay.")]);

  it("publishes a card, and answers an agent with a token in a room of its own", async () => {
    await start(quiet);
    const card = await call(AWAY, "team", "GET", "/ext/a2a/.well-known/agent-card.json", undefined);
    expect(card.status).toBe(200);
    const parsed = AgentCard.fromJSON(card.json);
    expect(parsed.name).toBe("Team");
    expect(parsed.supportedInterfaces[0]).toMatchObject({
      url: `${AWAY}/v1/a/team/ext/a2a/rpc`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    });
    expect(card.json.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe("Bearer");

    const { client, token } = await letIn();
    // Its room has its player and the admins, and only what `offer` turns on.
    const room = (await away.rooms.list(context)).find((each) => each.id === client.roomId)!;
    expect(room.name).toBe("With Planner");
    const on = (await away.roomExtensions(client.roomId, context))
      .filter((each) => each.enabled)
      .map((each) => each.name);
    expect(on).toContain("booker");

    expect(
      (await call(AWAY, "team", "POST", "/ext/a2a/rpc", "a2a_wrong", { jsonrpc: "2.0", id: 1 }))
        .status,
    ).toBe(401);

    const agent = await sdkClient(token);
    const result = await agent.sendMessage(send("When are you free next week?"));
    const task = Task.toJSON(result as Task) as {
      id: string;
      contextId: string;
      status: { state: string };
      artifacts: { parts: { text: string }[] }[];
    };
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts[0]!.parts[0]!.text).toBe("Thursday after three works.");

    const again = Task.toJSON(await agent.getTask(GetTaskRequest.fromJSON({ id: task.id }))) as {
      history: { role: string; parts: { text: string }[] }[];
    };
    expect(again.history.map((message) => message.role)).toEqual(["ROLE_USER", "ROLE_AGENT"]);
    expect(again.history[0]!.parts[0]!.text).toBe("When are you free next week?");
    const listed = await agent.listTasks(ListTasksRequest.fromJSON({ contextId: task.contextId }));
    expect(listed.tasks.map((each) => each.id)).toEqual([task.id]);

    // The room shows it as the agent's message, for the admins to read along.
    const transcript = await (
      await away.conversation(client.roomId, context)
    ).entries({ order: "ascending" }, 50, undefined, context);
    expect(JSON.stringify(transcript.items)).toContain("Planner, an outside agent, says");

    // Its token stops working once an admin removes it.
    expect(
      (await call(AWAY, "team", "DELETE", `/ext/a2a/clients/${client.id}`, awayAdmin)).status,
    ).toBe(204);
    await expect(agent.getTask(GetTaskRequest.fromJSON({ id: task.id }))).rejects.toThrow();
  });

  it("keeps a task working while its people decide, then pushes how it ended", async () => {
    await start(quiet);
    const { client, token } = await letIn();
    const agent = await sdkClient(token);
    const result = await agent.sendMessage(
      send("Book Friday with us, please.", {
        configuration: { taskPushNotificationConfig: { url: `${HOOKS}/planner`, token: "hook-1" } },
      }),
    );
    const task = Task.toJSON(result as Task) as {
      id: string;
      status: { state: string; message: { parts: { text: string }[] } };
    };
    expect(task.status.state).toBe("TASK_STATE_WORKING");
    expect(task.status.message.parts[0]!.text).toContain("Waiting for this assistant's people");
    expect(task.status.message.parts[0]!.text).toContain("Book Friday");

    const asked = (await pending(away, client.roomId))[0]!;
    expect(asked).toMatchObject({ extension: "booker", kind: "book" });
    await away.approvals.decide(client.roomId, asked.id, { approve: true, by: ann }, context);

    await until(() =>
      hooks.some(
        (hook) =>
          (hook.body as { task: { status: { state: string } } }).task.status.state ===
          "TASK_STATE_COMPLETED",
      ),
    );
    const done = hooks.find(
      (hook) =>
        (hook.body as { task: { status: { state: string } } }).task.status.state ===
        "TASK_STATE_COMPLETED",
    )!;
    expect(done.token).toBe("hook-1");
    expect(JSON.stringify(done.body)).toContain("Friday is booked.");
    const after = Task.toJSON(await agent.getTask(GetTaskRequest.fromJSON({ id: task.id }))) as {
      status: { state: string };
    };
    expect(after.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("messages an agent an admin added, and goes on in the same conversation", async () => {
    let conversation = "";
    const homeScript: Script = (_request, last) => {
      if (last.startsWith("Vegard (") && /Ask Team when/.test(last))
        return fauxAssistantMessage(
          [fauxToolCall("message_agent", { agent: "Team", text: "When are you free next week?" })],
          { stopReason: "toolUse" },
        );
      if (last.startsWith("Vegard (") && /And after that/.test(last))
        return fauxAssistantMessage(
          [fauxToolCall("message_agent", { agent: "g1", text: "Book Friday then.", conversation })],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    await start(homeScript);
    const { token } = await letIn("Robin");
    const added = await call(HOME, "robin", "POST", "/ext/a2a/agents", homeAdmin, {
      url: `${AWAY}/v1/a/team/ext/a2a`,
      token,
    });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ id: "g1", name: "Team", hasToken: true });

    await say(home, "Ask Team when they are free", vegard);
    const state = (await home.harness.snapshot(A2ADoc, context))!;
    const [id, remembered] = Object.entries(state.conversations)[0]!;
    expect(remembered.state).toBe("TASK_STATE_COMPLETED");
    conversation = id;
    const entries = await (
      await home.conversation(LOBBY, context)
    ).entries({ order: "ascending" }, 50, undefined, context);
    const text = JSON.stringify(entries.items);
    expect(text).toContain("Thursday after three works.");
    expect(text).toContain("Team, an outside agent, says");

    // Booking needs away's people: robin hears back once they decided.
    await say(home, "And after that, book Friday", vegard);
    const awayState = (await away.harness.snapshot(A2ADoc, context))!;
    expect(Object.values(awayState.tasks).map((task) => task.task.contextId)).toEqual([id, id]);
    const call_ = Object.values((await home.harness.snapshot(A2ADoc, context))!.calls)[0]!;
    expect(call_).toMatchObject({ status: "open", state: "TASK_STATE_WORKING" });
    // A wrong token is turned away, even one as long as the right one with a non-ASCII letter.
    const forged = await between(`${HOME}/v1/a/robin/ext/a2a/push/${call_.id}`, {
      method: "POST",
      headers: { "X-A2A-Notification-Token": `é${call_.pushToken.slice(1)}` },
      body: "{}",
    });
    expect(forged.status).toBe(404);
    const room = Object.values(awayState.clients)[0]!.roomId;
    const asked = (await pending(away, room))[0]!;
    await away.approvals.decide(room, asked.id, { approve: true, by: ann }, context);
    // Away pushes to robin, which reads the task and tells the lobby.
    await until(
      async () =>
        Object.values((await home.harness.snapshot(A2ADoc, context))!.calls)[0]!.status === "done",
    );
    await until(async () => {
      const items = (
        await (
          await home.conversation(LOBBY, context)
        ).entries({ order: "ascending" }, 100, undefined, context)
      ).items;
      return JSON.stringify(items).includes("Friday is booked.");
    });
  });

  it("takes no call from an agent's room, a retry once, and no more than the hourly limit", async () => {
    await start(quiet, { awaySettings: { maxMessagesPerHour: 1 } });
    const { client, token } = await letIn();
    const agent = await sdkClient(token);
    const message = {
      message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "When are you free?" }] },
    };
    const first = Task.toJSON(
      (await agent.sendMessage(SendMessageRequest.fromJSON(message))) as Task,
    ) as { id: string };
    const retry = Task.toJSON(
      (await agent.sendMessage(SendMessageRequest.fromJSON(message))) as Task,
    ) as { id: string };
    expect(retry.id).toBe(first.id);
    const over = Task.toJSON((await agent.sendMessage(send("And now?"))) as Task) as {
      status: { state: string };
    };
    expect(over.status.state).toBe("TASK_STATE_REJECTED");

    // The model in an agent's room can't call agents on its own, so no chain of agents talks.
    await call(AWAY, "team", "POST", "/ext/a2a/agents", awayAdmin, {
      url: `${AWAY}/v1/a/team/ext/a2a`,
    });
    const chained = Task.toJSON(
      (await (
        await sdkClient((await letIn("Other")).token)
      ).sendMessage(send("Ask your agents something"))) as Task,
    ) as { artifacts: { parts: { text: string }[] }[] };
    expect(chained.artifacts[0]!.parts[0]!.text).toContain("own people's rooms");
    expect(client.roomId).toBeDefined();
  });

  it("turns down a message without a messageId instead of taking it for a retry", async () => {
    await start(quiet);
    const { token } = await letIn();
    const sent = (text: string, id: number) =>
      call(AWAY, "team", "POST", "/ext/a2a/rpc", token, {
        jsonrpc: "2.0",
        id,
        method: "SendMessage",
        params: { message: { role: "ROLE_USER", parts: [{ text }] } },
      });
    const first = await sent("When are you free?", 1);
    const second = await sent("And next week?", 2);
    expect(first.json.error?.message).toContain("messageId");
    expect(second.json.error?.message).toContain("messageId");
    expect(Object.keys((await away.harness.snapshot(A2ADoc, context))?.tasks ?? {})).toEqual([]);
  });
});
