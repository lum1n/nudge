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
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import mcp, { fillVariables, type PanelInput, type PanelOutput, toolName } from "../src/index.ts";
import { fakeOAuthServer } from "./fake-oauth.ts";

const context = BACKGROUND_CONTEXT;
const FAKE = join(import.meta.dirname, "fake-server.mjs");
const author = { playerId: "owner", displayName: "Vegard" };

/** The tools and prompt in effect at the end of a request; changes come as later system messages. */
function current(request: ModelContext | undefined): { tools: string[]; prompt: string } {
  const tools = new Set<string>();
  const sections: Record<string, string> = {};
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const [key, text] of Object.entries(message.sections ?? {}))
      if (text === null) delete sections[key];
      else sections[key] = text;
  }
  return { tools: [...tools], prompt: Object.values(sections).join("\n") };
}

function lastToolResult(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "toolResult");
  return (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("mcp", () => {
  let dir: string;
  let nudge: Nudge | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-mcp-"));
    process.env.NUDGE_MCP_TEST_TOKEN = "t0ken";
    process.env.NUDGE_MCP_TEST_SECRET = "must-not-pass";
  });
  afterEach(async () => {
    await nudge?.close(context);
    nudge = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function open(servers: Record<string, unknown>) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const requests: ModelContext[] = [];
    const outputs: string[] = [];
    nudge = await createNudge(
      {
        database: join(dir, "a.sqlite"),
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [{ extension: mcp, settings: { servers } }],
      },
      context,
    );
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => (r: ModelContext) => {
      requests.push(r);
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    };
    const done = (r: ModelContext) => {
      requests.push(r);
      outputs.push(lastToolResult(r));
      return fauxAssistantMessage([fauxText("Done.")]);
    };
    const say = async (text: string) => {
      const settled = await (await nudge!.submit(LOBBY, { text, author }, context)).wait(context);
      if (settled.status !== "done") throw new Error(JSON.stringify(settled));
    };
    return { faux, requests, outputs, call, done, say, nudge };
  }

  /** A client of the MCP panel of the lobby, as the server would connect it. */
  async function panel(nudge: Nudge) {
    const frames: PanelOutput[] = [];
    const waiters: (() => void)[] = [];
    const room = (await nudge.rooms.get(LOBBY, context))!;
    const session = await nudge.roomSocket("mcp")!(
      { room, player: { id: "ann", displayName: "Ann", createdAt: 0 }, admin: false },
      {
        send: (data) => {
          frames.push(JSON.parse(data) as PanelOutput);
          for (const wake of waiters.splice(0)) wake();
        },
        close: () => {},
      },
    );
    let refs = 0;
    const send = async (input: PanelInput) => {
      const ref = `r${++refs}`;
      session.receive(JSON.stringify({ ...input, ref }));
      const reply = () => frames.find((f) => f.type !== "servers" && f.ref === ref);
      while (reply() === undefined) await new Promise<void>((resolve) => waiters.push(resolve));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return reply()!;
    };
    const servers = () =>
      frames.findLast((f): f is Extract<PanelOutput, { type: "servers" }> => f.type === "servers")!
        .servers;
    return { send, servers, close: () => session.close() };
  }

  /** The first player, an admin, and another who isn't. */
  async function players(nudge: Nudge) {
    const by = async (name: string) => {
      const { player } = await nudge.players.invite(name, context);
      return { playerId: player.id, displayName: player.displayName };
    };
    return { admin: await by("Vegard"), ann: await by("Ann") };
  }

  it("adds a program a room asks for once an admin approves, with keys set on the panel", async () => {
    const { faux, outputs, call, done, say, nudge } = await open({});
    const { admin, ann } = await players(nudge);
    faux.setResponses([
      call("add_mcp_server", {
        name: "notes",
        useFor: "Keeping notes",
        command: process.execPath,
        args: [FAKE],
        keys: [{ in: "env", name: "TOKEN" }],
      }),
      done,
    ]);
    await say("Add the notes server");
    expect(outputs.at(-1)).toBe("Waiting for approval a1.");
    const [pending] = await nudge.approvals.list(LOBBY, context);
    expect(pending).toMatchObject({ adminOnly: true });
    expect(pending?.summary).toMatch(/^Start the program `.+fake-server\.mjs` on the server/);
    await expect(
      nudge.approvals.decide(LOBBY, "a1", { approve: true, by: ann }, context),
    ).rejects.toThrow("Only an admin");
    const added = await nudge.approvals.decide(LOBBY, "a1", { approve: true, by: admin }, context);
    expect(added.result).toContain("needs TOKEN set on the room's MCP servers panel");
    await nudge.harness.waitForIdle(context);

    const { send, servers, close } = await panel(nudge);
    expect(servers()).toMatchObject([
      { id: "m1", name: "notes", keys: [{ in: "env", name: "TOKEN", set: false }] },
    ]);
    expect(
      await send({ type: "setKey", server: "m1", key: "TOKEN", value: "s3cret-value" }),
    ).toEqual({ type: "ok", ref: "r1" });
    expect(servers()[0]?.keys[0]?.set).toBe(true);

    faux.setResponses([
      call("mcp_tools", { server: "notes", search: "word" }),
      done,
      call("mcp_call", { server: "notes", tool: "env" }),
      done,
      call("mcp_call", { server: "notes", tool: "save", arguments: { note: "Buy milk" } }),
      done,
      done,
    ]);
    await say("Which tools look up words?");
    expect(outputs.at(-1)).toContain("- lookup: Look up a word");
    expect(outputs.at(-1)).not.toContain("save");
    await say("Show your environment");
    const env = JSON.parse(outputs.at(-1)!) as Record<string, string>;
    // The program got the key; the model only a stand-in for it.
    expect(env.TOKEN).not.toBe("s3cret-value");
    expect(outputs.at(-1)).not.toContain("s3cret-value");
    expect(env.NUDGE_MCP_TEST_SECRET).toBeUndefined();
    await say("Save a note: buy milk");
    expect(outputs.at(-1)).toBe("Waiting for approval a2.");
    // Anyone in the room decides a call.
    expect(
      await nudge.approvals.decide(LOBBY, "a2", { approve: true, by: ann }, context),
    ).toMatchObject({ status: "done", result: "Saved 1 notes." });
    await nudge.harness.waitForIdle(context);

    faux.setResponses([call("remove_mcp_server", { server: "notes" }), done]);
    await say("Remove the notes server");
    expect(outputs.at(-1)).toBe("Removed the MCP server notes.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(servers()).toEqual([]);
    close();
  });

  it("signs in to a remote server with OAuth from the panel", async () => {
    const remote = await fakeOAuthServer();
    try {
      const { faux, outputs, call, done, say, nudge } = await open({});
      const { ann } = await players(nudge);
      faux.setResponses([
        call("add_mcp_server", { name: "docs", useFor: "Searching the docs", url: remote.url }),
        done,
      ]);
      await say("Add the docs server");
      const [pending] = await nudge.approvals.list(LOBBY, context);
      expect(pending?.adminOnly).toBeUndefined();
      const added = await nudge.approvals.decide(LOBBY, "a1", { approve: true, by: ann }, context);
      expect(added.result).toContain("needs someone in the room to sign in");
      await nudge.harness.waitForIdle(context);

      const { send, servers, close } = await panel(nudge);
      expect(servers()[0]).toMatchObject({ name: "docs", signedIn: false });
      const started = await send({ type: "signIn", server: "m1", base: "https://nudge.test/" });
      if (started.type !== "signIn") throw new Error(JSON.stringify(started));
      const authorize = new URL(started.url);
      expect(authorize.origin + authorize.pathname).toBe(remote.url.replace("/mcp", "/authorize"));
      const redirect = authorize.searchParams.get("redirect_uri")!;
      expect(redirect).toMatch(/^https:\/\/nudge\.test\/v1\/a\/[^/]+\/ext\/mcp\/oauth\/callback$/);

      // The browser comes back with a code.
      const { route } = nudge.extensionRoute("mcp", "GET", "/oauth/callback")!;
      const back = (query: string) =>
        route.handle(new Request(`${redirect}?${query}`), { admin: false, params: {}, context });
      expect((await back("code=the-code&state=wrong")).status).toBe(400);
      const state = authorize.searchParams.get("state")!;
      const page = await back(`code=the-code&state=${state}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Signed in");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(servers()[0]).toMatchObject({ signedIn: true });

      faux.setResponses([
        call("mcp_call", { server: "docs", tool: "search", arguments: { query: "fjords" } }),
        done,
      ]);
      await say("Search the docs for fjords");
      expect(outputs.at(-1)).toBe("Found fjords.");

      expect(await send({ type: "signOut", server: "m1" })).toMatchObject({ type: "ok" });
      expect(servers()[0]).toMatchObject({ signedIn: false });
      close();
    } finally {
      await remote.close();
    }
  });

  it("names tools and fills in variables", () => {
    expect(toolName("git-hub", "list.issues")).toBe("mcp__git-hub__list_issues");
    expect(toolName("s", "x".repeat(80))).toHaveLength(64);
    expect(fillVariables("Bearer ${NUDGE_MCP_TEST_TOKEN}", process.env)).toBe("Bearer t0ken");
    expect(() => fillVariables("${NUDGE_NOPE}", process.env)).toThrow("$NUDGE_NOPE is not set");
  });

  it("offers a server's tools through tool_search, calls reads at once and asks for writes", async () => {
    const { faux, requests, outputs, call, done, say, nudge } = await open({
      fake: { command: process.execPath, args: [FAKE], env: { TOKEN: "${NUDGE_MCP_TEST_TOKEN}" } },
    });
    faux.setResponses([
      call("tool_search", { query: "look up a word" }),
      call(toolName("fake", "lookup"), { word: "fjord" }),
      done,
    ]);
    await say("What is a fjord?");
    const first = current(requests[0]);
    expect(first.tools).toContain("tool_search");
    expect(first.tools).not.toContain("mcp__fake__lookup");
    expect(first.prompt).toContain("- fake: lookup, save, env, pid, picture");
    expect(current(requests[1]).tools).toContain("mcp__fake__lookup");
    expect(outputs.at(-1)).toBe("fjord: a word. Call Ann on ⟦PHONE1⟧.");
    // The model saw the phone number only as a placeholder.
    expect(JSON.stringify(requests.at(-1))).not.toContain("987 65 432");

    faux.setResponses([
      call("tool_search", { query: "save note env pid picture", limit: 8 }),
      call(toolName("fake", "save"), { note: "Buy milk" }),
      done,
      done,
    ]);
    await say("Save a note: buy milk");
    expect(outputs.at(-1)).toBe("Waiting for approval a1.");
    const decided = await nudge.approvals.decide(
      LOBBY,
      "a1",
      { approve: true, by: { playerId: "owner", displayName: "Vegard" } },
      context,
    );
    expect(decided).toMatchObject({ status: "done", result: "Saved 1 notes." });
    // The room hears the outcome as a new turn.
    await nudge.harness.waitForIdle(context);

    faux.setResponses([
      call(toolName("fake", "env"), {}),
      done,
      call(toolName("fake", "picture"), {}),
      done,
    ]);
    await say("Show your environment");
    const env = JSON.parse(outputs.at(-1)!) as Record<string, string>;
    expect(env.TOKEN).toBe("t0ken");
    expect(env.NUDGE_MCP_TEST_SECRET).toBeUndefined();
    expect(env.PATH).toContain("/usr/bin");
    await say("Show the picture");
    expect(outputs.at(-1)).toBe("[an image, not shown]");
  });

  it("leaves out a server it can't start, and stops the programs it started at close", async () => {
    const { faux, requests, outputs, call, done, say, nudge } = await open({
      fake: { command: process.execPath, args: [FAKE] },
      broken: { command: join(dir, "no-such-program") },
      unset: { command: process.execPath, args: [FAKE], env: { X: "${NUDGE_MCP_UNSET}" } },
    });
    faux.setResponses([
      call("tool_search", { query: "pid" }),
      call(toolName("fake", "pid"), {}),
      done,
    ]);
    await say("Which process?");
    const prompt = current(requests[0]).prompt;
    expect(prompt).toContain("- broken: ");
    expect(prompt).toContain("- unset: $NUDGE_MCP_UNSET is not set");
    const pid = Number(outputs.at(-1));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await nudge.close(context);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("tells the model when no servers are set up", async () => {
    const { faux, requests, done, say } = await open({});
    faux.setResponses([done]);
    await say("Which MCP tools do you have?");
    const first = current(requests[0]);
    expect(first.tools).not.toContain("tool_search");
    expect(first.prompt).toContain("No MCP servers were added in this conversation");
  });

  it("refuses bad server settings", async () => {
    await expect(open({ "Bad Name": { command: "x" } })).rejects.toThrow("is not lower-case");
    await expect(open({ both: { command: "x", url: "http://x" } })).rejects.toThrow(
      "needs either command or url",
    );
  });
});
