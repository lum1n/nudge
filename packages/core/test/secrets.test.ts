import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scrubSecrets, SecretStore } from "../src/secrets.ts";

const dir = () => mkdtempSync(join(tmpdir(), "nudge-secrets-"));

describe("SecretStore", () => {
  it("keeps secrets per scope, encrypted at rest, readable again with the key", () => {
    const at = dir();
    const store = new SecretStore(at);
    store.set("room-1", "api-key", "sk-ThisIsSecret");
    store.set("room-2", "api-key", "other-key");
    expect(readFileSync(join(at, "secrets.enc"), "utf8")).not.toContain("sk-ThisIsSecret");
    expect(statSync(join(at, "key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(at, "secrets.enc")).mode & 0o777).toBe(0o600);

    const again = new SecretStore(at);
    expect(again.get("room-1", "api-key")).toBe("sk-ThisIsSecret");
    expect(again.get("room-2", "api-key")).toBe("other-key");
    expect(again.get("room-1", "other-name")).toBeUndefined();
  });

  it("replaces a secret, deletes one, lists names without values, and refuses a wrong key", () => {
    const at = dir();
    const store = new SecretStore(at);
    store.set("r", "k", "one");
    store.set("r", "k", "two");
    expect(store.get("r", "k")).toBe("two");
    expect(store.names("r")).toEqual(["k"]);
    expect(store.delete("r", "k")).toBe(true);
    expect(store.get("r", "k")).toBeUndefined();
    expect(store.delete("r", "k")).toBe(false);

    store.set("r", "k2", "three");
    writeFileSync(join(at, "key"), Buffer.alloc(32, 7).toString("base64"));
    expect(() => new SecretStore(at).get("r", "k2")).toThrow();
  });

  it("keeps secrets per scope independently", () => {
    const at = dir();
    const store = new SecretStore(at);
    store.set("a", "k", "va");
    store.set("b", "k", "vb");
    expect(store.names("a")).toEqual(["k"]);
    expect(store.names("b")).toEqual(["k"]);
    expect(store.get("a", "k")).toBe("va");
    expect(store.get("b", "k")).toBe("vb");
  });

  it("keeps secrets in memory without a directory", () => {
    const store = new SecretStore(undefined);
    store.set("r", "k", "v");
    expect(store.get("r", "k")).toBe("v");
    expect(existsSync(join(tmpdir(), "nudge-secrets-missing"))).toBe(false);
  });

  it("uses NUDGE_SECRETS_KEY instead of a key file when it is set", () => {
    const at = dir();
    const key = Buffer.alloc(32, 3).toString("base64");
    process.env.NUDGE_SECRETS_KEY = key;
    try {
      new SecretStore(at).set("r", "k", "v");
      expect(existsSync(join(at, "key"))).toBe(false);
      expect(new SecretStore(at).get("r", "k")).toBe("v");
      process.env.NUDGE_SECRETS_KEY = "short";
      expect(() => new SecretStore(at).get("r", "k")).toThrow(/32-byte/);
    } finally {
      delete process.env.NUDGE_SECRETS_KEY;
    }
  });
});

describe("scrubSecrets", () => {
  it("replaces every occurrence of each value, and ignores empty ones", () => {
    expect(scrubSecrets("key=sk-abc&retry=sk-abc", ["sk-abc"])).toBe("key=[secret]&retry=[secret]");
    expect(scrubSecrets("a b", ["", undefined])).toBe("a b");
    expect(scrubSecrets("token tok123 and tok123 again", ["tok123"])).toBe(
      "token [secret] and [secret] again",
    );
  });
});
