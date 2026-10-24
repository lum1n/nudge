import { describe, expect, it, vi } from "vitest";
import { reachesPrivate } from "../src/browser.ts";

const lookup = vi.hoisted(() =>
  vi.fn(async (name: string) => {
    const addresses: Record<string, string[]> = {
      "rebind.example": ["127.0.0.1"],
      "lan.example": ["93.184.215.14", "192.168.1.20"],
      "v6.example": ["fd00::1"],
      "public.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    };
    const found = addresses[name];
    if (!found)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
);
vi.mock("node:dns/promises", () => ({ lookup }));

describe("reachesPrivate", () => {
  it("catches names that resolve to this machine or the local network", async () => {
    expect(await reachesPrivate("rebind.example")).toBe(true);
    expect(await reachesPrivate("lan.example")).toBe(true);
    expect(await reachesPrivate("v6.example")).toBe(true);
  });

  it("lets public names through, and leaves names that don't resolve to Chromium", async () => {
    expect(await reachesPrivate("public.example")).toBe(false);
    expect(await reachesPrivate("nowhere.example")).toBe(false);
  });

  it("knows private names and addresses without asking DNS", async () => {
    lookup.mockClear();
    expect(await reachesPrivate("localhost")).toBe(true);
    expect(await reachesPrivate("[::1]")).toBe(true);
    expect(await reachesPrivate("10.0.0.1")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("asks DNS once a while per name", async () => {
    lookup.mockClear();
    await reachesPrivate("PUBLIC.example");
    await reachesPrivate("public.example");
    expect(lookup).not.toHaveBeenCalled();
  });
});
