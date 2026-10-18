import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWired, ServerWired } from "@nudge/core";
import { fetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningServer, serveNudge } from "../src/serve.ts";

// Wired is optional and not published yet: point NUDGE_WIRED_MODULE at a build of
// github.com/lum1n/wired's bindings/node to run these.
const wired = await loadWired();

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function addr(server: RunningServer): string {
  return new URL(server.url).host;
}

describe.skipIf(wired === undefined)("Wired between servers", () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.reverse()) await step();
    cleanup.length = 0;
    delete process.env.NUDGE_WIRED_INVITE;
    delete process.env.NUDGE_WIRED_RELAY_URL;
  });

  it("a home server and a server it launched reach each other, through the new server's relay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-wired-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    // Home: holds the network, no public address, no relay.
    const home = new ServerWired({ dir: join(dir, "home"), publicUrl: () => undefined });
    const homeApi = await serveNudge({ assistants: new Map(), port: 0 });
    cleanup.push(() => homeApi.close(), () => home.stop());
    expect((await home.enableRoot("home", addr(homeApi))).state).toBe("root");

    // A new server, as on exe.dev: one port, with the relay behind it. Home lists the relay
    // first and hands over the invite, as the launcher does.
    const port = await freePort();
    const relayUrl = `http://127.0.0.1:${port}`;
    process.env.NUDGE_WIRED_INVITE = await home.addRelay(relayUrl);
    process.env.NUDGE_WIRED_RELAY_URL = relayUrl;
    const robin = new ServerWired({
      dir: join(dir, "robin"),
      publicUrl: () => undefined,
      relayBind: `127.0.0.1:${await freePort()}`,
    });
    await robin.load();
    const front = robin.relayFront();
    expect(front).toBeDefined();
    const robinApi = await serveNudge({ assistants: new Map(), port, ...(front ? { relay: front } : {}) });
    cleanup.push(() => robinApi.close(), () => robin.stop());
    await robin.resume("robin", addr(robinApi));
    expect(robin.state()).toMatchObject({ state: "member", name: "robin", relay: relayUrl });

    // Each reaches the other's API by name.
    const fromRobin = await fetch("http://nudge.home.wired/v1/nothing", { dispatcher: robin.dispatcher() });
    expect(fromRobin.status).toBe(404);
    expect(await fromRobin.json()).toEqual({ error: "Not found" });
    const fromHome = await fetch("http://nudge.robin.wired/v1/nothing", { dispatcher: home.dispatcher() });
    expect(fromHome.status).toBe(404);

    // The relay shares robin's port without getting in the way of its API.
    expect((await fetch(`${relayUrl}/v1/nothing`)).status).toBe(404);
    expect(home.state()).toMatchObject({
      state: "root",
      relays: [relayUrl],
      members: expect.arrayContaining([{ name: "robin", anchor: false }]),
    });

    // Restarting picks the same role and network up again, without the environment.
    delete process.env.NUDGE_WIRED_INVITE;
    delete process.env.NUDGE_WIRED_RELAY_URL;
    await robin.stop();
    const again = new ServerWired({
      dir: join(dir, "robin"),
      publicUrl: () => undefined,
      relayBind: `127.0.0.1:${await freePort()}`,
    });
    await again.load();
    expect(again.relayFront()).toBeDefined();
    await again.resume("robin", addr(robinApi));
    cleanup.push(() => again.stop());
    expect(again.state().state).toBe("member");
  }, 60_000);

  it("only the root adds relays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-wired-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const off = new ServerWired({ dir: join(dir, "x"), publicUrl: () => undefined });
    await expect(off.addRelay("https://robin.exe.xyz")).rejects.toThrow(/Only the server/);
    expect(off.state()).toEqual({ state: "off" });
  });
});
