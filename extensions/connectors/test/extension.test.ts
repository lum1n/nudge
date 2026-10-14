import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge, type NudgeOptions, SecretStore } from "@nudge/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import connectors from "../src/extension.ts";
import { addConnector, updateConnector } from "../src/model.ts";
import { fixture, start } from "./fixture.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };

let server: Server;
let base: string;
beforeAll(async () => {
  server = fixture();
  base = await start(server);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The sections in effect at the end of a request; pi-durable sends changes as later system messages. */
function sections(request: ModelContext | undefined): string {
  const out: Record<string, string> = {};
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const [key, text] of Object.entries(message.sections ?? {}))
      if (text === null) delete out[key];
      else out[key] = text;
  }
  return Object.values(out).join("\n");
}

/** The text of a request's last tool result. */
function lastToolResult(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "toolResult");
  const block = message?.content[0];
  return block?.type === "text" ? block.text : "";
}

function setup(dir: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  const options: NudgeOptions = {
    database: join(dir, "a.sqlite"),
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    timeZone: "Europe/Oslo",
    extensions: [connectors],
  };
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => () =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const outputs: string[] = [];
  const done = (request: ModelContext) => {
    requests.push(request);
    outputs.push(lastToolResult(request));
    return fauxAssistantMessage([fauxText("Noted.")]);
  };
  const plain = (request: ModelContext) => {
    requests.push(request);
    return fauxAssistantMessage("Sure.");
  };
  const say = async (nudge: Nudge, text: string) => {
    const settled = await (await nudge.submit(LOBBY, { text, author: by }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };
  /** Where `setUpExtension` puts this extension's secrets: `<database>.extensions/connectors/secrets`. */
  const secretsDir = join(dir, "a.sqlite.extensions", "connectors", "secrets");
  return { faux, options, requests, call, done, plain, outputs, say, secretsDir };
}

describe("@nudge/ext-connectors", () => {
  it("adds a connector only once approved, and shows it in the section afterwards", async () => {
    const room = await mkdtemp(join(tmpdir(), "nudge-connectors-add-"));
    try {
      const { faux, options, requests, call, done, plain, outputs, say } = setup(room);
      const nudge = await createNudge(options, context);
      faux.setResponses([
        call("add_connector", { name: "Fixture", baseUrl: `${base}/`, useFor: "Testing" }),
        done,
        plain, // the approval's own follow-up, once someone decides it
      ]);
      await say(nudge, "Add the fixture API");
      expect(outputs[0]).toMatch(/Waiting for approval a1/);
      expect(sections(requests.at(-1))).not.toContain("Fixture");

      const pending = await nudge.approvals.list(LOBBY, context);
      expect(pending).toMatchObject([{ id: "a1", status: "pending" }]);
      const decided = await nudge.approvals.decide(LOBBY, "a1", { approve: true, by }, context);
      expect(decided).toMatchObject({ status: "done", result: "Added connector c1 (Fixture)." });
      await nudge.harness.waitForIdle(context);

      faux.setResponses([plain]);
      await say(nudge, "Hello");
      expect(sections(requests.at(-1))).toContain("c1 Fixture: Testing");
      await nudge.close(context);
    } finally {
      await rm(room, { recursive: true, force: true });
    }
  });

  it("refuses to add twice over the pending limit and reports a bad base URL", async () => {
    const room = await mkdtemp(join(tmpdir(), "nudge-connectors-bad-"));
    try {
      const { faux, options, call, done, outputs, say } = setup(room);
      const nudge = await createNudge(options, context);
      faux.setResponses([
        call("add_connector", { name: "Bad", baseUrl: "not a url", useFor: "x" }),
        done,
      ]);
      await say(nudge, "Add it");
      expect(outputs[0]).toMatch(/Waiting for approval/);
      const [pending] = await nudge.approvals.list(LOBBY, context);
      const decided = await nudge.approvals.decide(
        LOBBY,
        pending!.id,
        { approve: true, by },
        context,
      );
      expect(decided).toMatchObject({ status: "failed" });
      expect(decided.result).toMatch(/not a URL/);
      await nudge.close(context);
    } finally {
      await rm(room, { recursive: true, force: true });
    }
  });

  it("runs a read at once, needs approval for a write, and scrubs the secret from the result", async () => {
    const room = await mkdtemp(join(tmpdir(), "nudge-connectors-call-"));
    try {
      const { faux, options, call, done, plain, outputs, say, secretsDir } = setup(room);

      // What a person does in the web panel (C3): set the key before anything calls the API.
      new SecretStore(secretsDir).set(LOBBY, "c1", "sk-room-secret");

      const nudge = await createNudge(options, context);
      // Seed the connector directly, as `add_connector` would once approved.
      await nudge.harness.commit(
        (tx) =>
          addConnector(
            tx,
            LOBBY,
            {
              name: "Fixture",
              baseUrl: `${base}/`,
              useFor: "Testing",
              auth: { in: "header", name: "x-api-key" },
            },
            "Vegard",
            0,
          ),
        context,
      );
      // The fixture is on 127.0.0.1; a person turns this on in the panel for local APIs (C3).
      await nudge.harness.commit(
        (tx) => updateConnector(tx, LOBBY, "c1", { allowPrivateNetwork: true }),
        context,
      );

      faux.setResponses([
        call("call_api", {
          connector: "c1",
          method: "GET",
          path: "/echo",
          query: { q: "sk-room-secret" },
        }),
        done,
      ]);
      await say(nudge, "Call the fixture API");
      expect(outputs[0]).toContain("200 Fixture/echo");
      expect(outputs[0]).not.toContain("sk-room-secret");
      const body = JSON.parse(outputs[0]!.split("\n\n")[1]!) as { apiKey: string; query: unknown };
      expect(body.apiKey).toBe("[secret]");
      expect(body.query).toEqual({ q: "[secret]" });
      expect(await nudge.approvals.list(LOBBY, context)).toEqual([]);

      faux.setResponses([
        call("call_api", { connector: "c1", method: "POST", path: "/echo", body: "x" }),
        done,
        plain, // the approval's own follow-up
      ]);
      await say(nudge, "Post to the fixture API");
      expect(outputs[1]).toMatch(/Waiting for approval/);
      const [pending] = await nudge.approvals.list(LOBBY, context);
      expect(pending).toMatchObject({ status: "pending", summary: "POST Fixture/echo" });
      const decided = await nudge.approvals.decide(
        LOBBY,
        pending!.id,
        { approve: true, by },
        context,
      );
      expect(decided).toMatchObject({ status: "done" });
      expect(decided.result).toContain("200 Fixture/echo");
      expect(decided.result).not.toContain("sk-room-secret");
      await nudge.harness.waitForIdle(context);

      await nudge.close(context);
    } finally {
      await rm(room, { recursive: true, force: true });
    }
  });

  it("calls without a set key fail clearly instead of sending an empty secret", async () => {
    const room = await mkdtemp(join(tmpdir(), "nudge-connectors-nokey-"));
    try {
      const { faux, options, call, done, outputs, say } = setup(room);
      const nudge = await createNudge(options, context);
      await nudge.harness.commit(
        (tx) =>
          addConnector(
            tx,
            LOBBY,
            {
              name: "Fixture",
              baseUrl: `${base}/`,
              useFor: "Testing",
              auth: { in: "header", name: "x-api-key" },
            },
            "Vegard",
            0,
          ),
        context,
      );
      faux.setResponses([
        call("call_api", { connector: "c1", method: "GET", path: "/echo" }),
        done,
      ]);
      await say(nudge, "Call it");
      expect(outputs[0]).toMatch(/needs an API key/);
      await nudge.close(context);
    } finally {
      await rm(room, { recursive: true, force: true });
    }
  });

  it("lets a person mark a path as a read; the model can't set readPaths itself", async () => {
    const room = await mkdtemp(join(tmpdir(), "nudge-connectors-readpaths-"));
    try {
      const { faux, options, call, done, outputs, say } = setup(room);
      const nudge = await createNudge(options, context);
      await nudge.harness.commit(
        (tx) =>
          addConnector(
            tx,
            LOBBY,
            { name: "Fixture", baseUrl: `${base}/`, useFor: "Testing" },
            "Vegard",
            0,
          ),
        context,
      );
      // The tool has no `readPaths` parameter; only direct doc access (the panel, in C3) sets it.
      await nudge.harness.commit(
        (tx) =>
          updateConnector(tx, LOBBY, "c1", {
            readPaths: ["POST /echo"],
            allowPrivateNetwork: true,
          }),
        context,
      );

      faux.setResponses([
        call("call_api", { connector: "c1", method: "POST", path: "/echo", body: "x" }),
        done,
      ]);
      await say(nudge, "Post to the fixture API");
      expect(outputs[0]).toContain("200 Fixture/echo");
      expect(await nudge.approvals.list(LOBBY, context)).toEqual([]);
      await nudge.close(context);
    } finally {
      await rm(room, { recursive: true, force: true });
    }
  });

  it("changing the base address needs approval; other fields change at once", async () => {
    const room = await mkdtemp(join(tmpdir(), "nudge-connectors-update-"));
    try {
      const { faux, options, call, done, outputs, say } = setup(room);
      const nudge = await createNudge(options, context);
      await nudge.harness.commit(
        (tx) =>
          addConnector(
            tx,
            LOBBY,
            { name: "Fixture", baseUrl: `${base}/`, useFor: "Testing" },
            "Vegard",
            0,
          ),
        context,
      );

      faux.setResponses([call("update_connector", { connector: "c1", notes: "Learned it" }), done]);
      await say(nudge, "Remember a note");
      expect(outputs[0]).toBe("Updated connector c1.");

      faux.setResponses([
        call("update_connector", { connector: "c1", baseUrl: "https://elsewhere.example/" }),
        done,
      ]);
      await say(nudge, "Point it somewhere else");
      expect(outputs[1]).toMatch(/Waiting for approval/);
      const [pending] = await nudge.approvals.list(LOBBY, context);
      expect(pending!.status).toBe("pending");
      await nudge.close(context);
    } finally {
      await rm(room, { recursive: true, force: true });
    }
  });
});
