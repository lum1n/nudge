import { describe, expect, it } from "vitest";
import { startupLines } from "../src/commands/serve.ts";

const interfaces = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [
    { address: "192.168.1.180", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
} as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

describe("nudge serve's startup lines", () => {
  it("says how to reach it from a phone when it listens on this computer only", () => {
    const lines = startupLines("http://127.0.0.1:8787", "127.0.0.1", ["nudge"], "/web", interfaces);
    expect(lines[0]).toBe("Nudge is serving nudge at http://127.0.0.1:8787, with the web UI");
    expect(lines[1]).toContain("nudge serve --host 0.0.0.0");
  });

  it("lists the network addresses, and warns about plain HTTP, when it listens on all", () => {
    const lines = startupLines(
      "http://0.0.0.0:8787",
      "0.0.0.0",
      ["nudge", "robin"],
      undefined,
      interfaces,
    );
    expect(lines[0]).toBe("Nudge is serving nudge, robin at http://192.168.1.180:8787 (API only)");
    expect(lines[1]).toContain("Plain HTTP");
  });
});
