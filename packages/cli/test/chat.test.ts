import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  BACKGROUND_CONTEXT,
  createNudge,
  loadConfig,
  LOBBY,
  type Nudge,
  openAssistant,
} from "@nudge/core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@nudge/core/testing";
import { Hubs, type RunningServer, serveNudge } from "@nudge/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../src/commands/chat.ts";

const context = BACKGROUND_CONTEXT;
// oxlint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[\d+m/g, "");

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

/** Faux models that answer with `answers`, in order. */
function fauxModels(...answers: string[]) {
  const faux = fauxProvider({ tokensPerSecond: 2000 });
  faux.setResponses(answers.map((text) => fauxAssistantMessage(text)));
  const created = createModels();
  created.setProvider(faux.provider);
  return { models: created, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
}

let dir: string;
let config: string;
let out: string;
let stdin: PassThrough;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-chat-test-"));
  config = join(dir, "nudge.json");
  await writeFile(
    config,
    JSON.stringify({ assistants: [{ name: "robin", database: "data/robin.sqlite" }] }),
  );
  out = "";
  stdin = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  models.current = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Types `line`, then waits for `shown` to be printed after it. */
async function type(line: string, shown: string | RegExp): Promise<void> {
  const from = out.length;
  stdin.write(`${line}\n`);
  await vi.waitFor(
    () => {
      const since = plain(out.slice(from));
      if (typeof shown === "string") expect(since).toContain(shown);
      else expect(since).toMatch(shown);
    },
    { timeout: 5000 },
  );
}

/** Waits until the chat has printed its header, so the room is open. */
const opened = () => vi.waitFor(() => expect(out).toContain("Commands: /steer"), { timeout: 5000 });

describe("nudge chat, in this process", () => {
  it("chats in the lobby, and runs the slash commands", async () => {
    models.current = fauxModels("Hello, Vegard.");
    const done = chat({ config, name: "Vegard" });
    await opened();
    expect(out.startsWith("Robin · Commands:")).toBe(true);

    await type("hello", "Robin: Hello, Vegard.");
    await type("/who", "  Everyone");
    await type("/nudges", "  No nudges scheduled here.");
    await type("/approvals", "  Nothing to approve here.");
    await type("/extensions", "  No extensions installed.");
    await type("/memory", "  Nothing remembered here.");
    await type("/memory add The gate code is 4321", /Remembered (\S+)\./);
    const fact = /Remembered (\S+)\./.exec(out)![1]!;
    await type("/memory", `  ${fact}: The gate code is 4321`);
    await type(`/memory forget ${fact}`, "  Forgotten.");
    await type("/memory forget nope", "  ! No fact nope here");
    await type("/memory wipe", "  Usage: /memory add <text> | /memory forget <id>");
    await type("/nudges cancel nope", "  ! No nudge nope here");
    await type("/approve", "  Usage: /approve <id> | /deny <id>");
    await type("/extensions on nope", "  ! ");

    await type("/private Blue Door 17", /will see (\S+) instead\./);
    const placeholder = /will see (\S+) instead\./.exec(out)![1]!;
    await type("/hidden", `  ${placeholder} Blue Door 17`);
    await type(
      `/hidden forget ${placeholder}`,
      `  Forgotten: everyone now sees only ${placeholder}.`,
    );
    await type("/hidden", "  No values only you see.");
    await type("/hidden forget", "  Usage: /hidden forget <placeholder>");

    stdin.write("/quit\n");
    await done;

    // It let go of the database, and kept what was said.
    const loaded = await loadConfig(config);
    const nudge = await openAssistant(loaded, loaded.assistants[0]!, context);
    try {
      expect((await nudge.players.get("owner", context))?.displayName).toBe("Vegard");
      const lease = (await new Hubs(nudge, () => {}).room(LOBBY))!;
      const said = lease.hub.view().timeline;
      lease.release();
      expect(said.map((item) => item.type)).toEqual(["user", "answer"]);
    } finally {
      await nudge.close(context);
    }
  });

  it("opens your own room with me, and ends when the input does", async () => {
    models.current = fauxModels();
    const done = chat({ config, room: "me", name: "Vegard" });
    await opened();
    expect(out).toMatch(/^Robin · .+ · Commands:/);
    stdin.end();
    await done;
  });

  it("refuses a room or a player that isn't there, and lets go of the database", async () => {
    models.current = fauxModels();
    await expect(chat({ config, room: "nope" })).rejects.toThrow('No room "nope"');
    await expect(chat({ config, player: "bo" })).rejects.toThrow(
      'No player "bo"; add one with: nudge invite <name>',
    );
    const loaded = await loadConfig(config);
    await (await openAssistant(loaded, loaded.assistants[0]!, context)).close(context);
  });
});

describe("nudge chat --url", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let token: string;

  beforeEach(async () => {
    const { models, model } = fauxModels("Hi Ann, from the server.");
    nudge = await createNudge({ database: ":memory:", models, model }, context);
    token = (await nudge.players.invite("Ann", context)).token;
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
  });

  it("chats through the server, as the token's player", async () => {
    const done = chat({ config, url: server.url, token });
    await opened();
    await type("hello there", "Nudge: Hi Ann, from the server.");
    await type("/memory add Ann likes tea", /Remembered (\S+)\./);
    expect((await nudge.memory.visible(LOBBY, context)).map((fact) => fact.text)).toEqual([
      "Ann likes tea",
    ]);
    await type("/nudges cancel nope", "  ! No nudge nope here");
    stdin.write("/quit\n");
    await done;
  });

  it("takes the older address with the assistant in its path", async () => {
    const done = chat({ config, url: `${server.url}/a/robin`, token });
    await opened();
    stdin.end();
    await done;
  });

  it("says what is wrong with the address, the assistant or the token", async () => {
    await expect(chat({ config, url: server.url })).rejects.toThrow(
      "Connecting to a server needs a token: set NUDGE_TOKEN or pass --token",
    );
    await expect(chat({ config, url: "not a url", token })).rejects.toThrow(
      "--url not a url is not a URL",
    );
    await expect(chat({ config, url: server.url, token, assistant: "kim" })).rejects.toThrow(
      `${server.url} has no assistant "kim"; it has: robin`,
    );
    await expect(chat({ config, url: server.url, token: "nudge_wrong" })).rejects.toThrow(
      new RegExp(`^${server.url}: `),
    );
    await expect(chat({ config, url: server.url, token, room: "nope" })).rejects.toThrow(
      'No room "nope"',
    );
    await expect(chat({ config, url: "http://127.0.0.1:1", token })).rejects.toThrow(
      "Could not reach http://127.0.0.1:1",
    );
  });
});
