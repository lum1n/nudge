import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig, type Nudge, openAssistant } from "@nudge/core";
import { type RunningServer, serveNudge } from "@nudge/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admin,
  invite,
  nudges,
  pair,
  reload,
  renameRoom,
  revoke,
  room,
  token,
  tokens,
  usage,
} from "../src/commands/admin.ts";

const context = BACKGROUND_CONTEXT;

let dir: string;
let config: string;

/** What `run` printed with console.log, one entry per call. */
async function printed(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => lines.push(args.join(" ")));
  try {
    await run();
  } finally {
    log.mockRestore();
  }
  return lines;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-admin-test-"));
  config = join(dir, "nudge.json");
  await writeFile(
    config,
    JSON.stringify({ assistants: [{ name: "robin", database: "data/robin.sqlite" }] }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Options for a command run on this machine; `server` is only for the links it prints. */
const local = () => ({ config, server: "http://127.0.0.1:8787" });

describe("admin commands on the assistant's database", () => {
  it("invites a player, with a token that signs in and a link for the browser", async () => {
    const lines = await printed(() => invite({ ...local(), name: "Ingrid Hansen" }));
    expect(lines[0]).toMatch(/^Invited Ingrid Hansen as "ingrid[^"]*"\. Their token/);
    const issued = lines[1]!.trim();
    expect(issued).toMatch(/^nudge_/);
    expect(lines).toContain(`In a browser: http://127.0.0.1:8787/login#token=${issued}`);
    expect(lines).toContain(
      "In a terminal: NUDGE_TOKEN=<token> nudge chat --url http://127.0.0.1:8787",
    );

    // The token is the player's: it is listed, a new one can be issued, and each revoked.
    const id = /as "([^"]+)"/.exec(lines[0]!)![1]!;
    const listed = await printed(() => tokens({ ...local(), player: id }));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatch(new RegExp(`^${id}\\t\\S+\\t\\d{4}-`));

    const again = await printed(() => token({ ...local(), player: id }));
    expect(again[0]).toMatch(/^New token for Ingrid Hansen \(client \S+\), shown only now/);
    const clientId = /client (\S+)\)/.exec(again[0]!)![1]!;
    expect(again).toContain(`Revoke it with: nudge revoke ${clientId}`);
    expect(await printed(() => tokens(local()))).toHaveLength(2);

    expect(await printed(() => revoke({ ...local(), clientId }))).toEqual([
      `Revoked ${id}'s token for client ${clientId}.`,
    ]);
    await expect(revoke({ ...local(), clientId })).rejects.toThrow(
      `No token for client "${clientId}"; see nudge tokens`,
    );
  });

  it("names the players there are when one isn't known", async () => {
    await printed(() => invite({ ...local(), name: "Ann" }));
    for (const call of [
      () => token({ ...local(), player: "bo" }),
      () => pair({ ...local(), player: "bo" }),
      () => tokens({ ...local(), player: "bo" }),
      () => admin({ ...local(), player: "bo", remove: false }),
    ])
      await expect(call()).rejects.toMatchObject({
        name: "UsageError",
        message: 'No player "bo"; players: ann',
      });
  });

  it("prints a one-time pairing code with a link to this assistant", async () => {
    await printed(() => invite({ ...local(), name: "Ann" }));
    const lines = await printed(() => pair({ ...local(), player: "ann" }));
    const text = lines.join("\n");
    const code = /type the code (\S+) in the app/.exec(text)?.[1];
    expect(code).toBeDefined();
    expect(text).toContain(
      `nudge://pair?server=http%3A%2F%2F127.0.0.1%3A8787&assistant=robin&code=${code}`,
    );
    expect(text).toMatch(/It works once, until /);
  });

  it("makes and unmakes admins, but the first player stays one", async () => {
    await printed(() => invite({ ...local(), name: "Ann" }));
    await printed(() => invite({ ...local(), name: "Bo" }));
    expect(await printed(() => admin({ ...local(), remove: false }))).toEqual(["Admins: ann"]);
    expect(await printed(() => admin({ ...local(), player: "bo", remove: false }))).toEqual([
      "Admins: ann, bo",
    ]);
    expect(await printed(() => admin({ ...local(), player: "bo", remove: true }))).toEqual([
      "Admins: ann",
    ]);
    expect(await printed(() => admin({ ...local(), player: "ann", remove: true }))).toEqual([
      "ann is the first player, and stays an admin.",
      "Admins: ann",
    ]);
  });

  it("creates, lists and renames shared rooms", async () => {
    await printed(() => invite({ ...local(), name: "Ann" }));
    await printed(() => invite({ ...local(), name: "Bo" }));
    const created = await printed(() => room({ ...local(), name: "Trip", members: ["ann", "bo"] }));
    expect(created[0]).toMatch(/^Created room "[^"]+" for ann, bo\.$/);
    const id = /room "([^"]+)"/.exec(created[0]!)![1]!;

    const listed = await printed(() => room({ ...local(), members: [] }));
    expect(listed).toContain(`${id}\tshared\tTrip\tann, bo`);
    expect(listed.some((line) => line.startsWith("lobby\tlobby\t"))).toBe(true);

    expect(await printed(() => renameRoom({ ...local(), room: id, name: "Lofoten" }))).toEqual([
      `Room "${id}" is now called Lofoten.`,
    ]);
    expect(await printed(() => room({ ...local(), members: [] }))).toContain(
      `${id}\tshared\tLofoten\tann, bo`,
    );
  });

  it("says when nothing is scheduled or spent", async () => {
    expect(await printed(() => nudges(local()))).toEqual(["No nudges scheduled."]);
    const spent = await printed(() => usage(local()));
    expect(spent[0]).toBe("Budget: none");
    expect(spent[1]).toMatch(/^\d{4}-\d{2}\t\$0\.00$/);
  });
});

describe("admin commands while the assistant runs", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let adminToken: string;

  /** Options for a command that finds the database open and goes through `server`. */
  const remote = (withToken = true) => ({
    config,
    server: server.url,
    ...(withToken ? { token: adminToken } : {}),
  });

  beforeEach(async () => {
    const loaded = await loadConfig(config);
    // As `nudge serve` would: this process holds the database, so commands can't open it.
    nudge = await openAssistant(loaded, loaded.assistants[0]!, context);
    adminToken = (await nudge.players.invite("Ann", context)).token;
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
  });

  it("asks for an admin's token instead of opening the database", async () => {
    await expect(invite({ ...remote(false), name: "Bo" })).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringMatching(
        new RegExp(`^robin is running in process ${process.pid}\\. To go through its server at`),
      ),
    });
  });

  it("goes through the server with the token", async () => {
    const invited = await printed(() => invite({ ...remote(), name: "Bo" }));
    expect(invited[0]).toBe('Invited Bo as "bo".\n');
    expect(invited.join("\n")).toMatch(/type the code \S+ in the app/);
    expect(await nudge.players.get("bo", context)).toMatchObject({ displayName: "Bo" });

    expect(await printed(() => admin({ ...remote(), player: "bo", remove: false }))).toEqual([
      "Admins: ann, bo",
    ]);
    const created = await printed(() => room({ ...remote(), name: "Trip", members: ["bo"] }));
    expect(created).toEqual(['Created room "trip" for bo.']);
    expect(await printed(() => nudges(remote()))).toEqual(["No nudges scheduled."]);
  });

  it("passes on what the server says when it refuses", async () => {
    await expect(token({ ...remote(), player: "nobody" })).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringMatching(new RegExp(`^${server.url} said 404: `)),
    });
    await expect(tokens({ ...remote(), token: "nudge_not-a-token" })).rejects.toThrow(
      `${server.url} said 401`,
    );
  });

  it("says when the server can't be reached", async () => {
    await expect(nudges({ ...remote(), server: "http://127.0.0.1:1" })).rejects.toThrow(
      "Could not reach http://127.0.0.1:1",
    );
  });

  it("reload signals the process that holds the database", async () => {
    const hangups: string[] = [];
    const onHangup = () => hangups.push("SIGHUP");
    process.on("SIGHUP", onHangup);
    try {
      const lines = await printed(async () => expect(await reload({ config })).toBe(true));
      expect(lines).toEqual([
        `robin: asked process ${process.pid} to reload; it prints the result`,
      ]);
      await vi.waitFor(() => expect(hangups).toEqual(["SIGHUP"]));
    } finally {
      process.off("SIGHUP", onHangup);
    }
  });
});

describe("nudge reload", () => {
  it("says so, and fails, when no process has the assistant open", async () => {
    let result: boolean | undefined;
    const lines = await printed(async () => (result = await reload({ config })));
    expect(result).toBe(false);
    expect(lines).toEqual(["robin: not running"]);
  });
});
