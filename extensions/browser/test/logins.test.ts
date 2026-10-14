import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoginStore } from "../src/logins.ts";

const dir = () => mkdtempSync(join(tmpdir(), "nudge-logins-"));

describe("LoginStore", () => {
  it("keeps logins per room, encrypted at rest, readable again with the key", () => {
    const at = dir();
    const store = new LoginStore(at);
    store.save("room-1", {
      host: "login.example.no",
      username: "ola",
      password: "Hemmelig123!",
      savedAt: 1,
    });
    store.save("room-2", { host: "other.no", password: "x", savedAt: 2 });
    expect(readFileSync(join(at, "logins.enc"), "utf8")).not.toContain("Hemmelig123!");
    expect(statSync(join(at, "key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(at, "logins.enc")).mode & 0o777).toBe(0o600);

    const again = new LoginStore(at);
    expect(again.find("room-1", "login.example.no")?.password).toBe("Hemmelig123!");
    expect(again.find("room-2", "login.example.no")).toBeUndefined();
    expect(again.list("room-1")).toHaveLength(1);
  });

  it("replaces a host's login, forgets one, and refuses a wrong key", () => {
    const at = dir();
    const store = new LoginStore(at);
    store.save("r", { host: "a.no", password: "one", savedAt: 1 });
    store.save("r", { host: "a.no", password: "two", savedAt: 2 });
    expect(store.list("r")).toEqual([{ host: "a.no", password: "two", savedAt: 2 }]);
    expect(store.forget("r", "a.no")).toBe(true);
    expect(store.list("r")).toEqual([]);

    store.save("r", { host: "a.no", password: "three", savedAt: 3 });
    writeFileSync(join(at, "key"), Buffer.alloc(32, 7).toString("base64"));
    expect(() => new LoginStore(at).list("r")).toThrow();
  });

  it("keeps logins in memory without a directory", () => {
    const store = new LoginStore(undefined);
    store.save("r", { host: "a.no", password: "p", savedAt: 1 });
    expect(store.find("r", "a.no")?.password).toBe("p");
  });

  it("uses NUDGE_BROWSER_KEY instead of a key file when it is set", () => {
    const at = dir();
    const key = Buffer.alloc(32, 3).toString("base64");
    process.env.NUDGE_BROWSER_KEY = key;
    try {
      new LoginStore(at).save("r", { host: "a.no", password: "p", savedAt: 1 });
      expect(existsSync(join(at, "key"))).toBe(false);
      expect(new LoginStore(at).find("r", "a.no")?.password).toBe("p");
      process.env.NUDGE_BROWSER_KEY = "short";
      expect(() => new LoginStore(at).list("r")).toThrow(/32-byte/);
    } finally {
      delete process.env.NUDGE_BROWSER_KEY;
    }
  });
});
