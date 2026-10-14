import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertReachable,
  ConnectorError,
  fetchLocked,
  isPrivateAddress,
  isPrivateHostname,
  lockedUrl,
} from "../src/net.ts";
import { fixture, start } from "./fixture.ts";

describe("isPrivateAddress", () => {
  it("catches loopback, RFC 1918, link-local and CGNAT v4 ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.1.1",
      "100.64.0.1",
    ])
      expect(isPrivateAddress(address)).toBe(true);
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1"])
      expect(isPrivateAddress(address)).toBe(false);
  });

  it("catches IPv6 loopback, unique-local and link-local, and v4-mapped addresses", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  });
});

describe("isPrivateHostname", () => {
  it("catches localhost, .local-style names and literal private addresses", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("printer.local")).toBe(true);
    expect(isPrivateHostname("box.internal")).toBe(true);
    expect(isPrivateHostname("192.168.1.1")).toBe(true);
    expect(isPrivateHostname("example.com")).toBe(false);
  });
});

describe("lockedUrl", () => {
  const connector = { name: "Weather", baseUrl: "https://api.example.com/v1/" };

  it("joins a relative path onto the base URL", () => {
    const url = lockedUrl(connector, "forecast", { lat: "1", lon: "2" });
    expect(url.toString()).toBe("https://api.example.com/v1/forecast?lat=1&lon=2");
  });

  it("refuses a path that resolves outside the connector's own origin", () => {
    expect(() => lockedUrl(connector, "https://evil.example/steal")).toThrow(ConnectorError);
    expect(() => lockedUrl(connector, "//evil.example/steal")).toThrow(ConnectorError);
  });

  it("treats a leading slash as relative to the base path, not the origin's root", () => {
    const url = lockedUrl(connector, "/forecast", { lat: "1", lon: "2" });
    expect(url.toString()).toBe("https://api.example.com/v1/forecast?lat=1&lon=2");
  });

  it("appends onto a base URL missing its trailing slash, with or without a leading slash", () => {
    const noSlash = { name: "Weather", baseUrl: "https://api.example.com/v1" };
    expect(lockedUrl(noSlash, "forecast").toString()).toBe("https://api.example.com/v1/forecast");
    expect(lockedUrl(noSlash, "/forecast").toString()).toBe("https://api.example.com/v1/forecast");
  });
});

describe("assertReachable", () => {
  it("refuses a literal private address and local-looking names, unless allowed", async () => {
    await expect(assertReachable(new URL("http://127.0.0.1/"), false)).rejects.toThrow(
      ConnectorError,
    );
    await expect(assertReachable(new URL("http://localhost/"), false)).rejects.toThrow(
      ConnectorError,
    );
    await expect(assertReachable(new URL("http://127.0.0.1/"), true)).resolves.toBeUndefined();
  });
});

describe("fetchLocked", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = fixture();
    base = await start(server);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const connector = (allowPrivateNetwork = true) => ({
    name: "Fixture",
    baseUrl: `${base}/`,
    allowPrivateNetwork,
  });

  it("refuses the fixture's own loopback address unless allowed", async () => {
    await expect(
      fetchLocked(connector(false), lockedUrl(connector(false), "echo"), {
        method: "GET",
        headers: {},
      }),
    ).rejects.toThrow(ConnectorError);
  });

  it("sends the request and reports status, headers and body", async () => {
    const c = connector();
    const response = await fetchLocked(c, lockedUrl(c, "echo", { q: "oslo" }), {
      method: "GET",
      headers: { "x-api-key": "sk-test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ method: "GET", query: { q: "oslo" }, apiKey: "sk-test" });
  });

  it("follows a same-origin redirect, and refuses one that leaves the connector's address", async () => {
    const c = connector();
    const ok = await fetchLocked(c, lockedUrl(c, "redirect-ok"), { method: "GET", headers: {} });
    expect(JSON.parse(ok.body)).toMatchObject({ method: "GET", path: "/echo" });

    await expect(
      fetchLocked(c, lockedUrl(c, "redirect-away"), { method: "GET", headers: {} }),
    ).rejects.toThrow(/outside its own address/);
  });

  it("times out, and truncates a response over the size cap", async () => {
    const c = connector();
    await expect(
      fetchLocked(c, lockedUrl(c, "slow"), { method: "GET", headers: {} }, { timeoutMs: 100 }),
    ).rejects.toThrow(/did not answer in time/);

    const big = await fetchLocked(
      c,
      lockedUrl(c, "big"),
      { method: "GET", headers: {} },
      { maxBytes: 1000 },
    );
    expect(big.truncated).toBe(true);
    expect(big.body.length).toBe(1000);
  });
});
