import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  createNudge,
  LOBBY,
  type ModelContext,
  type Nudge,
  type RoomEvent,
  SecretStore,
} from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { scriptsExtension } from "@nudge/ext-scripts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AccEvent,
  accExtension,
  allowAndReject,
  Hosts,
  machines,
  quote,
  transcript,
} from "../src/index.ts";
import { FakeAcc, push } from "./fake.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };

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
    options: { approveStart?: boolean; database?: string; settings?: object; scripts?: true } = {},
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
      if (text.includes("Save this script: "))
        return fauxAssistantMessage(
          [
            fauxToolCall("save_script", {
              name: "hosts",
              description: "The machines",
              code: text.slice(text.indexOf("Save this script: ") + "Save this script: ".length),
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
          ...(options.scripts === undefined ? [] : [scriptsExtension]),
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

  it("keeps machines added at runtime, logging in with its key, and forgets them", async () => {
    const acc = new FakeAcc();
    const dir = mkdtempSync(join(tmpdir(), "nudge-acc-"));
    dirs.push(dir);
    const secrets = new SecretStore(join(dir, "secrets"));
    const configured = {
      name: "devbox",
      host: "10.0.0.2",
      port: 22,
      user: "u",
      auth: "key" as const,
      rooms: ["*"],
    };
    const added = join(dir, "added-hosts.json");
    const hosts = new Hosts([configured], acc, secrets, join(dir, "hosts.json"), "t", added);
    await expect(
      hosts.add({ name: "devbox", host: "x", port: 22, user: "u", rooms: ["*"] }),
    ).rejects.toThrow(/settings have/);
    await hosts.add({
      name: "proj-1",
      host: "proj-1.exe.xyz",
      port: 22,
      user: "exedev",
      rooms: ["r1"],
    });
    const later = new Hosts([configured], acc, secrets, join(dir, "hosts.json"), "t", added);
    expect(later.usableIn("r1").map((entry) => entry.name)).toEqual(["devbox", "proj-1"]);
    expect(later.usableIn("r2").map((entry) => entry.name)).toEqual(["devbox"]);
    await later.connect("proj-1");
    expect(acc.configs.at(-1)).toMatchObject({
      host: "proj-1.exe.xyz",
      user: "exedev",
      auth: { privateKey: "PRIVATE KEY" },
    });
    expect(await later.remove("proj-1")).toBe(true);
    expect(later.pinned("proj-1")).toBeUndefined();
    expect(later.entries.map((entry) => entry.name)).toEqual(["devbox"]);
  });

  it("lets a script look at the machines, but not ask to trust a host key", async () => {
    const acc = new FakeAcc();
    const { nudge, events, say } = await open(acc, { scripts: true });
    const answers = () => events.flatMap((e) => (e.type === "answer" ? [e.text] : []));
    await say("Save this script: return await tools.acc_hosts({});");
    expect(answers().at(-1)).toContain("Saved script hosts");
    expect(answers().at(-1)).toContain("devbox (u@10.0.0.2): reachable");

    await say("Save this script: return await tools.acc_hosts({ trust_new_key: 'devbox' });");
    expect(answers().at(-1)).toContain("Not saved");
    expect(answers().at(-1)).toContain("Scripts only read");
    expect(await nudge.approvals.list(LOBBY, context)).toEqual([]);
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
