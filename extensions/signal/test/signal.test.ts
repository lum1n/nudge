import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, defineNudgeExtension, type Nudge, requestApproval } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Envelope, parseAddress, signalExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/** `signal-cli daemon --tcp` as the bridge uses it. */
class FakeSignalCli {
  readonly server: Server;
  private sockets = new Set<Socket>();
  readonly sent: { recipient?: string[]; groupId?: string; message: string; account?: string }[] =
    [];
  private timestamp = 1_700_000_000_000;

  constructor() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      createInterface({ input: socket }).on("line", (line) => {
        const request = JSON.parse(line) as { id: string; method: string; params: any };
        if (request.method === "send") {
          this.sent.push(request.params);
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { timestamp: ++this.timestamp } })}\n`,
          );
        } else
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "Unknown method" } })}\n`,
          );
      });
    });
  }

  get connections(): number {
    return this.sockets.size;
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as { port: number }).port;
  }

  /** A message from `from`, to the bot or in a group; `wrapped` as a manual subscription sends it. */
  receive(from: { uuid: string; name: string }, text: string, group?: string, wrapped = false) {
    const envelope: Envelope = {
      source: from.uuid,
      sourceUuid: from.uuid,
      sourceName: from.name,
      timestamp: ++this.timestamp,
      dataMessage: {
        message: text,
        ...(group === undefined ? {} : { groupInfo: { groupId: group } }),
      },
    };
    const params = wrapped ? { subscription: 0, result: { envelope } } : { envelope };
    for (const socket of this.sockets)
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "receive", params })}\n`);
  }

  /** The daemon restarting: every connection drops. */
  drop() {
    for (const socket of this.sockets) socket.destroy();
  }

  to(recipient: string): string[] {
    return this.sent
      .filter((s) => s.recipient?.[0] === recipient || s.groupId === recipient)
      .map((s) => s.message);
  }

  close() {
    this.drop();
    this.server.close();
  }
}

const doer = defineNudgeExtension({
  name: "doer",
  version: "1",
  setup: () => ({ approvals: { do: async () => ({ text: "Done it." }) } }),
});

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("signal bridge", () => {
  let daemon: FakeSignalCli;
  let nudge: Nudge;
  const ann = { uuid: "uuid-ann", name: "Ann S" };

  beforeEach(async () => {
    daemon = new FakeSignalCli();
    const port = await daemon.listen();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const lastUser = (request: ModelContext) => {
      const message = request.messages.findLast((m) => m.role === "user");
      return typeof message?.content === "string"
        ? message.content
        : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
    };
    faux.setResponses(
      Array.from(
        { length: 20 },
        () => (request: ModelContext) =>
          fauxAssistantMessage([fauxText(`Answer to ${lastUser(request)}`)]),
      ),
    );
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          doer,
          {
            extension: signalExtension({ retryMs: 50, report: () => {} }),
            settings: { daemon: `127.0.0.1:${port}`, account: "+4790000000" },
          },
        ],
      },
      context,
    );
    await nudge.players.invite("Ann", context);
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann"] }, context);
    await until(() => daemon.connections === 1);
  });

  afterEach(async () => {
    await nudge.close(context);
    daemon.close();
  });

  it("links, talks, and decides approvals by command, through a daemon restart", async () => {
    const { code } = await nudge.players.pairingCode("ann", context);
    daemon.receive(ann, `/link ${code}`);
    await until(() => daemon.to("uuid-ann").length === 1);
    expect(daemon.to("uuid-ann")[0]).toMatch(/^Linked to Ann\./);
    expect(daemon.sent[0]!.account).toBe("+4790000000");

    daemon.receive(ann, "Hello there", undefined, true);
    await until(() => daemon.to("uuid-ann").length === 2);
    expect(daemon.to("uuid-ann")[1]).toMatch(/^Answer to Ann \(\d\d:\d\d\): Hello there$/);

    daemon.drop();
    await until(() => daemon.connections === 0);
    await until(() => daemon.connections === 1);

    daemon.receive(ann, "/room trip", "grp1");
    await until(() => daemon.to("grp1").length === 1);
    await nudge.harness.commit(
      (tx) =>
        requestApproval(
          tx,
          "trip",
          { extension: "doer", kind: "do", summary: "Book the cabin", payload: null },
          Date.now(),
        ),
      context,
    );
    // No buttons on Signal: the prompt names the commands.
    await until(() => daemon.to("grp1").length === 2);
    expect(daemon.to("grp1")[1]).toBe(
      "Waiting for approval (a1): Book the cabin\nSend /approve a1 or /deny a1.",
    );
    daemon.receive(ann, "/approve a1", "grp1");
    await until(() => daemon.to("grp1").length >= 3);
    expect(daemon.to("grp1")[2]).toBe("Approved by Ann: Done it.");
    expect((await nudge.approvals.get("trip", "a1", context))?.status).toBe("done");
  });

  it("reads host:port", () => {
    expect(parseAddress("127.0.0.1:7600")).toEqual({ host: "127.0.0.1", port: 7600 });
    expect(parseAddress("signal")).toEqual({ host: "signal", port: 7583 });
    expect(parseAddress("[::1]:9")).toEqual({ host: "::1", port: 9 });
  });
});
