import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTailnetHost, routeTailnet, stateOfStatus, Tailscale } from "../src/index.ts";

describe("tailnet hosts", () => {
  it("are MagicDNS names and the addresses Tailscale hands out", () => {
    expect(isTailnetHost("home.tail1234.ts.net")).toBe(true);
    expect(isTailnetHost("100.64.0.1")).toBe(true);
    expect(isTailnetHost("100.127.255.254")).toBe(true);
    expect(isTailnetHost("[fd7a:115c:a1e0::1]")).toBe(true);
    expect(isTailnetHost("100.63.0.1")).toBe(false);
    expect(isTailnetHost("100.128.0.1")).toBe(false);
    expect(isTailnetHost("robin.exe.xyz")).toBe(false);
    expect(isTailnetHost("ts.net.example.com")).toBe(false);
  });

  it("are told apart by what tailscale status says", () => {
    expect(stateOfStatus({ BackendState: "NeedsLogin", AuthURL: "" })).toEqual({
      state: "starting",
    });
    expect(stateOfStatus({ BackendState: "NeedsLogin", AuthURL: "https://login/a" })).toEqual({
      state: "needs-login",
      authUrl: "https://login/a",
    });
    expect(stateOfStatus({ BackendState: "NeedsMachineAuth" })).toEqual({
      state: "needs-approval",
    });
    expect(
      stateOfStatus({
        BackendState: "Running",
        TailscaleIPs: ["100.64.0.9"],
        Self: { DNSName: "nudge-robin.tail1234.ts.net." },
      }),
    ).toEqual({
      state: "connected",
      name: "nudge-robin.tail1234.ts.net",
      addresses: ["100.64.0.9"],
    });
  });
});

/**
 * A stand-in for Tailscale's tarball: `tailscaled` waits, and `tailscale` keeps its state in a
 * file beside the socket, logging in at once with a key and otherwise asking for a login.
 */
const TAILSCALED = `#!/bin/sh
exec sleep 600
`;
const TAILSCALE = `#!/bin/sh
dir=$(dirname "\${1#--socket=}")
shift
case "$1" in
  status) cat "$dir/status.json" 2>/dev/null || echo '{"BackendState":"NeedsLogin","AuthURL":""}' ;;
  up)
    echo "$@" >"$dir/up-args"
    case "$*" in
      *--auth-key=*) echo '{"BackendState":"Running","TailscaleIPs":["100.64.0.9"],"Self":{"DNSName":"nudge-robin.tail1.ts.net."}}' >"$dir/status.json" ;;
      *) echo '{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/x"}' >"$dir/status.json"; exec sleep 5 ;;
    esac ;;
  logout) rm -f "$dir/status.json" ;;
esac
`;

describe("Tailscale", () => {
  let dir: string;
  let tailscale: Tailscale | undefined;
  const served = new Map<string, Buffer | string>();
  const fetcher: typeof fetch = async (input) => {
    const body = served.get(String(input));
    return body === undefined
      ? new Response("no", { status: 404 })
      : new Response(typeof body === "string" ? body : new Uint8Array(body));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-tailscale-"));
    const root = join(dir, "build", "tailscale_1.2.3_amd64");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "tailscaled"), TAILSCALED);
    await writeFile(join(root, "tailscale"), TAILSCALE);
    await chmod(join(root, "tailscaled"), 0o755);
    await chmod(join(root, "tailscale"), 0o755);
    const tgz = join(dir, "build", "ts.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", join(dir, "build"), "tailscale_1.2.3_amd64"]);
    const archive = await readFile(tgz);
    served.clear();
    served.set(
      "https://pkgs.tailscale.com/stable/?mode=json",
      JSON.stringify({ Tarballs: { amd64: "tailscale_1.2.3_amd64.tgz" } }),
    );
    served.set("https://pkgs.tailscale.com/stable/tailscale_1.2.3_amd64.tgz", archive);
    served.set(
      "https://pkgs.tailscale.com/stable/tailscale_1.2.3_amd64.tgz.sha256",
      `${createHash("sha256").update(archive).digest("hex")}\n`,
    );
  });

  afterEach(async () => {
    tailscale?.stop();
    tailscale = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const make = () =>
    (tailscale = new Tailscale({
      dir: join(dir, "server", "tailscale"),
      hostname: () => "nudge-robin",
      arch: "x64",
      fetch: fetcher,
    }));

  it("is off until an owner connects it", async () => {
    const ts = make();
    expect(await ts.state()).toEqual({ state: "off" });
    await ts.resume();
    expect(ts.proxy).toBeUndefined();
  });

  it("installs, starts and asks for a login without a key", async () => {
    const ts = make();
    const state = await ts.connect();
    expect(state).toEqual({ state: "needs-login", authUrl: "https://login.tailscale.com/a/x" });
    expect(ts.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const args = await readFile(join(dir, "server", "tailscale", "up-args"), "utf8");
    expect(args).toContain("--hostname=nudge-robin");
  });

  it("connects at once with a key, and stays connected across restarts", async () => {
    const ts = make();
    expect(await ts.connect("tskey-auth-x")).toMatchObject({
      state: "connected",
      name: "nudge-robin.tail1.ts.net",
    });
    ts.stop();
    const again = make();
    await again.resume();
    expect(again.proxy).toBeDefined();
    expect((await again.state()).state).toBe("connected");
  });

  it("disconnects for good, keeping the binaries", async () => {
    const ts = make();
    await ts.connect("tskey-auth-x");
    expect(await ts.disconnect()).toEqual({ state: "off" });
    expect(ts.proxy).toBeUndefined();
    expect(existsSync(join(dir, "server", "tailscale", "bin", "tailscaled"))).toBe(true);
    await make().resume();
    expect(tailscale?.proxy).toBeUndefined();
  });

  it("refuses a download that isn't the one Tailscale published", async () => {
    served.set(
      "https://pkgs.tailscale.com/stable/tailscale_1.2.3_amd64.tgz.sha256",
      "0".repeat(64),
    );
    const state = await make().connect();
    expect(state.state).toBe("error");
    expect(state.error).toMatch(/isn't the one Tailscale published/);
    expect(existsSync(join(dir, "server", "tailscale", "bin"))).toBe(false);
  });
});

describe("routeTailnet", () => {
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

  it("sends fetches to tailnet addresses through the proxy, and the rest directly", async () => {
    const target = await listen(
      createServer((request, response) => response.end(`target ${request.url}`)),
    );
    const tunnelled: string[] = [];
    // A proxy that tunnels every CONNECT to the target, whatever host it names.
    const proxyServer = createServer();
    proxyServer.on("connect", (request, socket, head) => {
      tunnelled.push(request.url ?? "");
      const upstream = connect(target, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
    });
    const proxy = await listen(proxyServer);
    let on = true;
    routeTailnet(() => (on ? `http://127.0.0.1:${proxy}` : undefined));

    const viaTailnet = await fetch("http://100.64.0.1:8787/v1/key");
    expect(await viaTailnet.text()).toBe("target /v1/key");
    expect(tunnelled).toEqual(["100.64.0.1:8787"]);

    const direct = await fetch(`http://127.0.0.1:${target}/direct`);
    expect(await direct.text()).toBe("target /direct");
    expect(tunnelled).toHaveLength(1);

    on = false;
    await expect(
      fetch("http://100.64.0.1:8787/v1/key", { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    expect(tunnelled).toHaveLength(1);
  });
});
