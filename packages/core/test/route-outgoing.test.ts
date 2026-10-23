import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { routeOutgoing } from "../src/index.ts";

describe("routeOutgoing", () => {
  const servers: Server[] = [];
  const before = getGlobalDispatcher();

  afterEach(async () => {
    setGlobalDispatcher(before);
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    servers.length = 0;
  });

  const listen = async (server: Server) => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };

  it("sends fetches to *.wired hosts over Wired, and the rest directly", async () => {
    const target = await listen(
      createServer((request, response) => response.end(`${request.headers.host} ${request.url}`)),
    );
    const carried: string[] = [];
    // Stands in for the server's Wired: every host it is given is the target.
    const wired = new Agent({
      connect: (options, callback) => {
        carried.push(options.hostname);
        const socket = connect(target, "127.0.0.1", () => callback(null, socket));
      },
    });
    let on = true;
    routeOutgoing(() => (on ? wired : undefined));

    const over = await fetch("http://nudge.home.wired/v1/key");
    expect(await over.text()).toBe("nudge.home.wired /v1/key");
    expect(carried).toEqual(["nudge.home.wired"]);

    const direct = await fetch(`http://127.0.0.1:${target}/direct`);
    expect(await direct.text()).toBe(`127.0.0.1:${target} /direct`);
    expect(carried).toHaveLength(1);

    on = false;
    await expect(
      fetch("http://nudge.home.wired/v1/key", { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow();
    expect(carried).toHaveLength(1);
    await wired.close();
  });
});
