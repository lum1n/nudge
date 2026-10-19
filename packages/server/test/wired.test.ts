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

/** Waits until `done`, at most 150 s (a first join retries for up to 2 minutes). */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1500 && !done(); i++) await new Promise((r) => setTimeout(r, 100));
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
    await until(() => robin.state().state !== "starting");
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
    await until(() => again.state().state !== "starting");
    expect(again.state().state).toBe("member");
  }, 200_000);

  it("a running server joins later, and serves its relay without a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-wired-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const home = new ServerWired({ dir: join(dir, "home"), publicUrl: () => undefined });
    const homeApi = await serveNudge({ assistants: new Map(), port: 0 });
    cleanup.push(() => homeApi.close(), () => home.stop());
    await home.enableRoot("home", addr(homeApi));

    // Already running, with Wired available but off: its front forwards nothing yet.
    const port = await freePort();
    const relayUrl = `http://127.0.0.1:${port}`;
    const robin = new ServerWired({
      dir: join(dir, "robin"),
      publicUrl: () => relayUrl,
      relayBind: `127.0.0.1:${await freePort()}`,
    });
    await robin.load();
    const front = robin.relayFront();
    expect(front?.matches({ url: "/relay" })).toBe(false);
    const robinApi = await serveNudge({ assistants: new Map(), port, ...(front ? { relay: front } : {}) });
    cleanup.push(() => robinApi.close(), () => robin.stop());

    // As `nudge wired add` at home, then `nudge wired join` on robin.
    const invite = await home.addRelay(relayUrl);
    expect((await robin.join(invite, "robin", addr(robinApi))).state).toBe("starting");
    await until(() => robin.state().state !== "starting");
    expect(robin.state()).toMatchObject({ state: "member", relay: relayUrl });
    expect(front?.matches({ url: "/relay" })).toBe(true);
    const answer = await fetch("http://nudge.robin.wired/v1/nothing", { dispatcher: home.dispatcher() });
    expect(answer.status).toBe(404);
    await expect(robin.join(invite, "robin", addr(robinApi))).rejects.toThrow(/already/);

    // Turning it off leaves the network, stops the relay, and lets the server join again.
    await robin.forget();
    expect(robin.state()).toEqual({ state: "off" });
    expect(front?.matches({ url: "/relay" })).toBe(false);
    await robin.join(await home.addRelay(relayUrl), "robin", addr(robinApi));
    await until(() => robin.state().state !== "starting");
    expect(robin.state(), JSON.stringify(robin.state())).toMatchObject({ state: "member" });
  }, 200_000);

  it("a server that replaces a deleted one joins under its name once home removes the old one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-wired-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const home = new ServerWired({ dir: join(dir, "home"), publicUrl: () => undefined });
    const homeApi = await serveNudge({ assistants: new Map(), port: 0 });
    cleanup.push(() => homeApi.close(), () => home.stop());
    await home.enableRoot("home", addr(homeApi));

    const port = await freePort();
    const relayUrl = `http://127.0.0.1:${port}`;
    const server = async (sub: string) => {
      const wired = new ServerWired({
        dir: join(dir, sub),
        publicUrl: () => relayUrl,
        relayBind: `127.0.0.1:${await freePort()}`,
      });
      await wired.load();
      const front = wired.relayFront();
      const api = await serveNudge({ assistants: new Map(), port, ...(front ? { relay: front } : {}) });
      cleanup.push(() => api.close(), () => wired.stop());
      return { wired, api };
    };
    const joined = async ({ wired, api }: Awaited<ReturnType<typeof server>>) => {
      await wired.join(await home.addRelay(relayUrl), "robin", addr(api));
      await until(() => wired.state().state !== "starting");
      return wired.state();
    };

    // The first robin joins, then is deleted (gone, never told).
    const first = await server("robin-1");
    expect((await joined(first)).state).toBe("member");
    await first.wired.stop();
    await first.api.close();

    // A new robin, with a new key, at the same address: the name is still the old one's.
    const second = await server("robin-2");
    expect(await joined(second)).toMatchObject({
      state: "error",
      error: expect.stringMatching(/already called robin/),
    });

    // Home removes the old robin, and the new one joins.
    await expect(home.remove("home")).rejects.toThrow(/can't remove itself/);
    await expect(home.remove("nobody")).rejects.toThrow(/No server called nobody/);
    expect((await home.remove("robin")).members).toEqual([{ name: "home", anchor: true }]);
    await second.wired.forget();
    expect(await joined(second)).toMatchObject({ state: "member", name: "robin" });
  }, 200_000);

  it("only the root adds relays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-wired-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const off = new ServerWired({ dir: join(dir, "x"), publicUrl: () => undefined });
    await expect(off.addRelay("https://robin.exe.xyz")).rejects.toThrow(/Only the server/);
    expect(off.state()).toEqual({ state: "off" });
  });
});
