import { readFile, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  applyImmutable,
  decoder,
  type JsonValue,
  type Op,
  type WireOp,
} from "@earendil-works/chord/delta";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, InboxState } from "@earendil-works/pi-durable";
import { createNudge, FIRE_ENTRY, MESSAGE_ENTRY, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type ServerFrame, serveNudge } from "../src/index.ts";
import { publicOps } from "../src/view.ts";

const context = BACKGROUND_CONTEXT;

/**
 * What one `?format=view` client received, replayed by the web UI's and the projector's tests.
 * `NUDGE_RECORD=1` writes it again from a fresh run; the shape test below says when pi-durable
 * changed the view under it.
 */
const FIXTURE = new URL("../../protocol/test/fixtures/conversation-view.json", import.meta.url);

type Recording = {
  readonly me: string;
  readonly view: ConversationView;
  readonly frames: readonly (readonly WireOp[])[];
};

type ViewClient = {
  readonly frames: ServerFrame[];
  readonly raw: string[];
  /** The mirror after every frame, oldest first. */
  readonly revisions: ConversationView[];
  readonly mirror: () => ConversationView | undefined;
  readonly ready: Promise<void>;
  send(frame: object): void;
  close(): void;
};

function connectView(url: string, token: string): ViewClient {
  const socket = new WebSocket(`${url}?format=view`);
  const frames: ServerFrame[] = [];
  const raw: string[] = [];
  const revisions: ConversationView[] = [];
  const ops = decoder();
  let mirror: ConversationView | undefined;
  let ready: () => void;
  const isReady = new Promise<void>((resolve) => (ready = resolve));
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token })));
  socket.addEventListener("message", (event) => {
    raw.push(String(event.data));
    const frame = JSON.parse(String(event.data)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "view") {
      mirror = frame.value;
      ready();
    } else if (frame.type === "ops") {
      mirror = applyImmutable(mirror, ops.decode(frame.ops));
    } else return;
    revisions.push(mirror);
  });
  return {
    frames,
    raw,
    revisions,
    mirror: () => mirror,
    ready: isReady,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
}

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Every path the views hold, with the type found there: array items merge, and transcript entries
 * are told apart by kind. Values differ between runs; this does not, unless the shape changed.
 */
function shape(views: readonly ConversationView[]): string[] {
  const paths = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      paths.add(`${path}: array`);
      for (const item of value) walk(item, `${path}[]`);
    } else if (value !== null && typeof value === "object") {
      paths.add(`${path}: object`);
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    } else paths.add(`${path}: ${value === null ? "null" : typeof value}`);
  };
  for (const view of views) {
    walk(view.conversation, "conversation");
    walk(view.docs, "docs");
    for (const entry of view.entries) walk(entry, `entries[${entry.kind}]`);
  }
  return [...paths].sort();
}

describe("view stream", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let stream: string;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    const faux = fauxProvider({ tokensPerSecond: 200 });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Ann wants this kept."),
          fauxText("I'll note that."),
          fauxToolCall("remember", { fact: "Ann likes tea" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Noted: Ann likes tea."),
      fauxAssistantMessage("And Bo likes coffee."),
      fauxAssistantMessage("Time to put the kettle on!"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        settings: { progress: { partialIntervalMs: 20 } },
      },
      context,
    );
    tokens = {};
    for (const name of ["Ann", "Bo", "Cy"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
    stream = `${server.url.replace("http", "ws")}/a/robin/rooms/trip/stream`;
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
  });

  it("mirrors the room's view in every client, without pi.provider", async () => {
    const ann = connectView(stream, tokens.Ann!);
    const bo = connectView(stream, tokens.Bo!);
    await Promise.all([ann.ready, bo.ready]);

    ann.send({ type: "submit", text: "Remember that I like tea", requestId: "1" });
    // Bo writes while the assistant is busy: the message waits in the inbox.
    await eventually(() => ann.mirror()?.docs["pi.live"]?.run !== undefined);
    bo.send({ type: "submit", text: "I like coffee", requestId: "1" });
    await nudge.harness.waitForIdle(context);
    await nudge.nudges.schedule("trip", { message: "Kettle", fireAt: Date.now() + 50 }, context);
    await eventually(() =>
      (ann.mirror()?.entries ?? []).some((entry) => entry.kind === FIRE_ENTRY),
    );
    await nudge.harness.waitForIdle(context);

    const server = (await (await nudge.conversation("trip", context)).viewState(context)).value;
    expect(server.docs["pi.provider"]).toBeDefined();
    const { "pi.provider": _, ...docs } = server.docs;
    const expected = { ...server, docs };
    await eventually(
      () =>
        JSON.stringify(ann.mirror()) === JSON.stringify(expected) &&
        JSON.stringify(bo.mirror()) === JSON.stringify(expected),
    );
    for (const client of [ann, bo])
      for (const frame of client.raw) expect(frame).not.toContain("pi.provider");

    const kinds = expected.entries.map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === MESSAGE_ENTRY)).toHaveLength(2);
    expect(kinds).toContain("pi.tool-result");
    const queued = (view: ConversationView) =>
      (view.docs["pi.inbox"] as InboxState).items.length > 0;
    expect(ann.revisions.some(queued)).toBe(true);
    expect(await nudge.memory.list("trip", context)).toMatchObject([{ text: "Ann likes tea" }]);

    if (process.env.NUDGE_RECORD === "1") {
      const ops = ann.frames.flatMap((frame) => (frame.type === "ops" ? [frame.ops] : []));
      const view = ann.revisions[0]!;
      await writeFile(
        FIXTURE,
        `${JSON.stringify({ me: "ann", view, frames: ops } satisfies Recording)}\n`,
      );
    }

    // The recorded fixture still has the shape a run has today.
    const recording = JSON.parse(await readFile(FIXTURE, "utf8")) as Recording;
    const replay = decoder();
    const recorded = [recording.view];
    for (const frame of recording.frames)
      recorded.push(applyImmutable(recorded.at(-1), replay.decode(frame)));
    expect(shape(recorded)).toEqual(shape(ann.revisions));

    for (const client of [ann, bo]) client.close();
  });

  it("drops pi.provider from replacements and whole-docs writes", () => {
    const view = {
      conversation: { id: 1 },
      entries: [],
      docs: { "pi.live": {}, "pi.provider": { sessionId: "s" } },
    } as unknown as JsonValue;
    const docs = { "pi.inbox": { items: [] }, "pi.provider": { sessionId: "s" } };
    const ops: Op[] = [
      ["r", view],
      ["s", ["docs"], docs],
      ["s", ["docs", "pi.provider"], { sessionId: "t" }],
      ["s", ["docs", "pi.provider", "sessionId"], "u"],
      ["d", ["docs", "pi.provider"]],
      ["s", ["docs", "pi.live", "run"], { taskId: 1, inputs: [] }],
    ];
    expect(publicOps(ops)).toEqual([
      ["r", { conversation: { id: 1 }, entries: [], docs: { "pi.live": {} } }],
      ["s", ["docs"], { "pi.inbox": { items: [] } }],
      ["s", ["docs", "pi.live", "run"], { taskId: 1, inputs: [] }],
    ]);
  });
});
