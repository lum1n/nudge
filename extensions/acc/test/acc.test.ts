import { mkdtempSync, rmSync } from "node:fs";
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
import { createNudge, LOBBY, type Nudge, type RoomEvent, SecretStore } from "@nudge/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AccBackend,
  type AccCommand,
  type AccEvent,
  type AccHost,
  type AccItem,
  type AccSession,
  accExtension,
  allowAndReject,
  type DetachedStatus,
  type HarnessId,
  Hosts,
  machines,
  quote,
  type SessionConfig,
  type SshConfig,
  transcript,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };

/** A session's log on the fake host: batches of events, read by every attachment from the start. */
type Log = {
  readonly harness: HarnessId;
  readonly cwd: string;
  readonly batches: AccEvent[][];
  readonly waiters: (() => void)[];
  items: AccItem[];
  readonly sent: AccCommand[];
};

function push(log: Log, ...events: AccEvent[]): void {
  log.batches.push(events);
  for (const wake of log.waiters.splice(0)) wake();
}

class FakeSession implements AccSession {
  offset = 0;
  constructor(
    readonly id: string,
    private readonly log: Log,
  ) {}
  async nextEvents(): Promise<AccEvent[]> {
    while (this.offset >= this.log.batches.length)
      await new Promise<void>((resolve) => this.log.waiters.push(resolve));
    return this.log.batches[this.offset++]!;
  }
  async send(command: AccCommand): Promise<void> {
    this.log.sent.push(command);
  }
  async stop(): Promise<void> {
    push(this.log, { type: "exited", code: 0 });
  }
  async status(): Promise<DetachedStatus> {
    return { status: "alive", pid: 1, size: this.log.batches.length };
  }
  state() {
    return null;
  }
  topLevelItems(): AccItem[] {
    return this.log.items;
  }
}

/** ACC's binding as the extension uses it, with one host whose key the test can change. */
class FakeAcc implements AccBackend {
  fingerprint = "SHA256:one";
  readonly logs = new Map<string, Log>();
  readonly configs: (SshConfig | "local")[] = [];
  keys = 0;
  private ids = 0;

  /** Configs of the hosts made, `"local"` for this machine. */
  localHost = (): AccHost => {
    this.configs.push("local");
    return this.make({
      host: "localhost",
      user: "",
      auth: { agent: true },
      hostKey: { acceptAny: true },
    });
  };

  host(config: SshConfig): AccHost {
    this.configs.push(config);
    return this.make(config);
  }

  private make(config: SshConfig): AccHost {
    return {
      connect: async () => {
        if (
          "fingerprints" in config.hostKey &&
          !config.hostKey.fingerprints.includes(this.fingerprint)
        )
          throw Object.assign(new Error(`untrusted host key ${this.fingerprint}`), {
            code: "HostKeyRejected",
          });
      },
      disconnect: async () => {},
      hostKeyFingerprint: () => this.fingerprint,
      exec: async (script: string) => {
        return script.includes("missing")
          ? { stdout: Buffer.alloc(0), stderr: Buffer.from("no such directory"), exitCode: 1 }
          : { stdout: Buffer.from("/home/u/proj\n"), stderr: Buffer.alloc(0), exitCode: 0 };
      },
      probe: async () => {
        return [
          {
            harness: "claude" as const,
            path: "/usr/bin/claude",
            version: "2.1.0",
            compat: "tested" as const,
          },
        ];
      },
      listSessions: async () => {
        return [...this.logs].map(([id, log]) => ({
          id,
          status: { status: "alive" as const, pid: 1, size: log.batches.length },
          modified: 0,
          spec: { harness: log.harness, cwd: log.cwd, model: null, title: null, created_ms: 0 },
        }));
      },
      launchSession: async (id: string, session: SessionConfig) => {
        const log: Log = {
          harness: session.harness,
          cwd: session.cwd,
          batches: [],
          waiters: [],
          items: [],
          sent: [],
        };
        this.logs.set(id, log);
        return new FakeSession(id, log);
      },
      attachSession: (id: string) => {
        const log = this.logs.get(id);
        if (log === undefined) throw new Error(`no session ${id}`);
        return new FakeSession(id, log);
      },
      removeSession: async (id: string) => {
        this.logs.delete(id);
      },
    };
  }

  generateKey(comment: string) {
    this.keys++;
    return { privateKey: "PRIVATE KEY", publicKey: `ssh-ed25519 AAAA ${comment}` };
  }

  newSessionId(harness: HarnessId): string {
    return `${harness}-s${++this.ids}`;
  }
}

function lastUser(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "user");
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(check: () => boolean | Promise<boolean>, timeout = 8_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const OPTIONS = [
  { id: "yes", label: "Allow", kind: "allow_once" },
  { id: "always", label: "Always allow", kind: "allow_always" },
  { id: "no", label: "Deny", kind: "reject_once" },
] as const;

const permission = (requestId: string, title: string): AccEvent => ({
  type: "permission_requested",
  request_id: requestId,
  title,
  options: OPTIONS,
  kind: "permission",
});

describe("acc", () => {
  const opened: Nudge[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const nudge of opened.splice(0)) await nudge.close(context);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function open(
    acc: FakeAcc,
    options: { approveStart?: boolean; database?: string; settings?: object } = {},
  ) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([
          fauxText(last.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
        ]);
      const text = lastUser(request);
      if (/start claude/i.test(text))
        return fauxAssistantMessage(
          [
            fauxToolCall("acc_start", {
              host: "devbox",
              harness: "claude",
              cwd: "~/proj",
              prompt: "Make the tests pass",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (/what runs here/i.test(text))
        return fauxAssistantMessage([fauxToolCall("acc_sessions", {})], { stopReason: "toolUse" });
      if (text.includes("finished its turn"))
        return fauxAssistantMessage([fauxText(`Heard: ${text}`)]);
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 200 }, () => answer));
    const events: RoomEvent[] = [];
    const nudge = await createNudge(
      {
        database: options.database ?? ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: accExtension({ backend: acc, report: () => {} }),
            settings: options.settings ?? {
              local: false,
              hosts: [{ name: "devbox", host: "10.0.0.2", user: "u" }],
              approveStart: options.approveStart ?? false,
            },
          },
        ],
      },
      context,
    );
    opened.push(nudge);
    nudge.events.subscribe((event) => events.push(event));
    const say = async (text: string) => {
      const settled = await (
        await nudge.submit(LOBBY, { text, author: by }, context)
      ).wait(context);
      if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
    };
    return { nudge, events, say };
  }

  it("starts a session the room follows, and passes the room's approvals to the agent", async () => {
    const acc = new FakeAcc();
    const { nudge, events, say } = await open(acc);
    await say("Start claude on devbox in ~/proj to make the tests pass");
    const log = acc.logs.get("claude-s1")!;
    expect(log.cwd).toBe("/home/u/proj");
    expect(log.sent).toEqual([{ type: "prompt", text: "Make the tests pass" }]);
    // Logged in with a key of its own, trusting the host's key the first time.
    expect(acc.configs[0]).toMatchObject({
      host: "10.0.0.2",
      user: "u",
      auth: { privateKey: "PRIVATE KEY" },
      hostKey: { acceptAny: true },
    });

    push(log, permission("r1", "Run npm test"));
    await until(async () => (await nudge.approvals.list(LOBBY, context)).length === 1);
    const [asked] = await nudge.approvals.list(LOBBY, context);
    expect(asked).toMatchObject({ extension: "acc", kind: "permission", status: "pending" });
    expect(asked!.summary).toContain("Run npm test");
    await nudge.approvals.decide(LOBBY, asked!.id, { approve: true, by }, context);
    expect(log.sent.at(-1)).toEqual({
      type: "answer_permission",
      request_id: "r1",
      option_id: "yes",
    });
    push(log, { type: "permission_resolved", request_id: "r1" });

    push(log, permission("r2", "Delete node_modules"));
    await until(async () => (await nudge.approvals.list(LOBBY, context)).length === 2);
    const [second] = await nudge.approvals.list(LOBBY, context);
    // Denying it tells the agent no.
    await nudge.approvals.decide(LOBBY, second!.id, { approve: false, by }, context);
    expect(log.sent.at(-1)).toEqual({
      type: "answer_permission",
      request_id: "r2",
      option_id: "no",
    });

    log.items = [
      {
        id: "1",
        kind: "user_message",
        status: "completed",
        text: "Make the tests pass",
        detail: { type: "text" },
      },
      {
        id: "2",
        kind: "agent_message",
        status: "completed",
        text: "All 12 tests pass now.",
        detail: { type: "text" },
      },
    ];
    push(log, { type: "turn_completed" });
    await until(() => events.some((e) => e.type === "answer" && e.cause === "nudge"));
    const told = events.find((e) => e.type === "answer" && e.cause === "nudge")!;
    expect(told.type === "answer" && told.text).toContain("All 12 tests pass now.");
  });

  it("waits for the room to approve starting a session", async () => {
    const acc = new FakeAcc();
    const { nudge, say } = await open(acc, { approveStart: true });
    await say("Start claude on devbox in ~/proj to make the tests pass");
    expect(acc.logs.size).toBe(0);
    const [asked] = await nudge.approvals.list(LOBBY, context);
    expect(asked).toMatchObject({ kind: "start", status: "pending" });
    // Machine names are readable to the model (ADR 15), so the summary names the machine.
    expect(asked!.summary).toContain("Start claude on devbox in ~/proj");
    const done = await nudge.approvals.decide(LOBBY, asked!.id, { approve: true, by }, context);
    expect(done.status).toBe("done");
    expect(acc.logs.get("claude-s1")?.sent).toEqual([
      { type: "prompt", text: "Make the tests pass" },
    ]);
  });

  it("keeps following across a restart without repeating what it told the room", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-acc-"));
    dirs.push(dir);
    const database = join(dir, "nudge.sqlite");
    const acc = new FakeAcc();
    const first = await open(acc, { database });
    await first.say("Start claude on devbox in ~/proj to make the tests pass");
    const log = acc.logs.get("claude-s1")!;
    push(log, { type: "turn_completed" });
    push(log, permission("r1", "Run npm test"));
    await until(async () => (await first.nudge.approvals.list(LOBBY, context)).length === 1);
    await until(() => first.events.some((e) => e.type === "answer" && e.cause === "nudge"));
    await first.nudge.close(context);
    opened.splice(opened.indexOf(first.nudge), 1);

    const second = await open(acc, { database });
    // The log replays: the request that still waits keeps its approval, and nothing is told again.
    await until(() => acc.configs.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const approvals = await second.nudge.approvals.list(LOBBY, context);
    expect(approvals.filter((a) => a.status === "pending")).toHaveLength(1);
    expect(second.events.some((e) => e.type === "answer" && e.cause === "nudge")).toBe(false);
    // The host key pinned the first time is required now.
    expect(acc.configs[1]).toMatchObject({ hostKey: { fingerprints: ["SHA256:one"] } });
    await second.nudge.approvals.decide(LOBBY, approvals[0]!.id, { approve: true, by }, context);
    expect(log.sent.at(-1)).toEqual({
      type: "answer_permission",
      request_id: "r1",
      option_id: "yes",
    });
  });

  it("pins a host's key, refuses another until it is trusted, and keeps one key of its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-acc-"));
    dirs.push(dir);
    const acc = new FakeAcc();
    const secrets = new SecretStore(undefined);
    const entry = {
      name: "devbox",
      host: "10.0.0.2",
      port: 22,
      user: "u",
      auth: "key" as const,
      rooms: ["*"],
    };
    const pins = join(dir, "hosts.json");
    await new Hosts([entry], acc, secrets, pins, "nudge-test").connect("devbox");
    acc.fingerprint = "SHA256:two";
    const later = new Hosts([entry], acc, secrets, pins, "nudge-test");
    await expect(later.connect("devbox")).rejects.toThrow(/different host key \(SHA256:two\)/);
    expect([...later.changedKeys]).toEqual([["devbox", "SHA256:two"]]);
    await later.trustNewKey("devbox");
    await later.connect("devbox");
    expect(later.pinned("devbox")).toBe("SHA256:two");
    expect(later.publicKey()).toBe("ssh-ed25519 AAAA nudge-test");
    expect(acc.keys).toBe(1);
  });

  it("reaches this machine's sessions with nothing set up", async () => {
    const acc = new FakeAcc();
    acc.logs.set("claude-here", {
      harness: "claude",
      cwd: "/home/me/app",
      batches: [],
      waiters: [],
      items: [],
      sent: [],
    });
    const { nudge, say } = await open(acc, { settings: {} });
    await say("What runs here?");
    expect(acc.configs).toEqual(["local"]);
    const conversation = await nudge.conversation(LOBBY, context);
    const entries = await conversation.entries({}, 50, undefined, context);
    expect(JSON.stringify(entries.items)).toContain("claude-here: claude in /home/me/app, running");
  });

  it("names machines by their address when unnamed, and keeps names apart", () => {
    const entry = (name: string) => ({
      name,
      host: name,
      port: 22,
      user: "u",
      auth: "key" as const,
      rooms: ["*"],
    });
    expect(
      machines(true, [entry("10.0.0.2"), entry("local"), entry("10.0.0.2")]).map((m) => m.name),
    ).toEqual(["local", "10.0.0.2", "local-2", "10.0.0.2-2"]);
    expect(machines(false, [entry("devbox")]).map((m) => m.name)).toEqual(["devbox"]);
  });

  it("picks the options that answer once, quotes for the shell, and shows a transcript", () => {
    expect(allowAndReject(OPTIONS)).toEqual({
      allow: "yes",
      reject: "no",
    });
    expect(
      allowAndReject([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]),
    ).toEqual({
      allow: "a",
      reject: "b",
    });
    expect(quote("it's here")).toBe(`'it'\\''s here'`);
    expect(
      transcript(
        [
          {
            id: "1",
            kind: "user_message",
            status: "completed",
            text: "Fix it",
            detail: { type: "text" },
          },
          {
            id: "2",
            kind: "reasoning",
            status: "completed",
            text: "hmm",
            detail: { type: "text" },
          },
          {
            id: "3",
            kind: "command_execution",
            status: "failed",
            text: "",
            detail: { type: "command", command: "npm test" },
          },
          {
            id: "4",
            kind: "file_change",
            status: "completed",
            text: "",
            detail: { type: "file_change", files: [{ path: "src/a.ts" }] },
          },
          {
            id: "5",
            kind: "agent_message",
            status: "completed",
            text: "Done.",
            detail: { type: "text" },
          },
        ],
        30,
      ),
    ).toBe("› Fix it\n$ npm test (failed)\n✎ src/a.ts\n‹ Done.");
  });
});
