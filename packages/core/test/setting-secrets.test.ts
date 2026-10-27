import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openSecrets,
  sealSecrets,
  secretReferences,
  SettingSecrets,
} from "../src/setting-secrets.ts";

const counter = () => {
  const put: string[] = [];
  return {
    put,
    seal: (secret: string) => {
      put.push(secret);
      return `\${secret:s${put.length}}`;
    },
  };
};

describe("sealSecrets", () => {
  it("stores writeOnly strings in properties, array items and allOf/anyOf/oneOf branches", () => {
    const schema = {
      type: "object",
      properties: {
        token: { type: "string", writeOnly: true },
        name: { type: "string" },
        accounts: {
          type: "array",
          items: { anyOf: [{ properties: { password: { type: "string", writeOnly: true } } }] },
        },
        smtp: { oneOf: [{ properties: { password: { writeOnly: true } } }] },
      },
    };
    const { put, seal } = counter();
    const sealed = sealSecrets(
      schema,
      {
        token: "t0ken",
        name: "Ann",
        accounts: [{ password: "one" }, { password: "two" }],
        smtp: { password: "three" },
        extra: "untouched",
      },
      seal,
    );
    expect(put).toEqual(["t0ken", "one", "two", "three"]);
    expect(sealed).toEqual({
      token: "${secret:s1}",
      name: "Ann",
      accounts: [{ password: "${secret:s2}" }, { password: "${secret:s3}" }],
      smtp: { password: "${secret:s4}" },
      extra: "untouched",
    });
  });

  it("leaves empty values, references and ${NAME} values alone", () => {
    const schema = { properties: { password: { type: "string", writeOnly: true } } };
    const { put, seal } = counter();
    for (const password of ["", "${secret:abc_-1}", "${MAIL_PASSWORD}", "pre-${MAIL_PASSWORD}"])
      expect(sealSecrets(schema, { password }, seal)).toEqual({ password });
    expect(put).toEqual([]);
  });

  it("stores a value that only looks like a reference", () => {
    const schema = { properties: { password: { writeOnly: true } } };
    const { put, seal } = counter();
    sealSecrets(schema, { password: "${secret:has space}" }, seal);
    expect(put).toEqual(["${secret:has space}"]);
  });

  it("leaves values the schema doesn't describe, or doesn't fit", () => {
    const { put, seal } = counter();
    expect(sealSecrets(undefined, { password: "x" }, seal)).toEqual({ password: "x" });
    expect(sealSecrets({ writeOnly: true }, 42, seal)).toBe(42);
    expect(sealSecrets({ properties: { a: { writeOnly: true } } }, ["x"], seal)).toEqual(["x"]);
    expect(put).toEqual([]);
  });
});

describe("openSecrets", () => {
  it("puts stored values back anywhere, and names the references it can't open", () => {
    const stored: Record<string, string> = { a: "hunter2" };
    const opened = openSecrets(
      { list: ["${secret:a}", "${secret:gone}"], nested: { b: "${secret:a}" }, n: 1, s: "x" },
      (id) => stored[id],
    );
    expect(opened.value).toEqual({
      list: ["hunter2", "${secret:gone}"],
      nested: { b: "hunter2" },
      n: 1,
      s: "x",
    });
    expect(opened.missing).toEqual(["gone"]);
  });

  it("opens only whole-string references", () => {
    const opened = openSecrets("pass: ${secret:a}", () => "hunter2");
    expect(opened).toEqual({ value: "pass: ${secret:a}", missing: [] });
  });

  it("lists the ids referred to", () => {
    expect(secretReferences({ a: "${secret:x}", b: ["${secret:y}", "${Y}"], c: null })).toEqual(
      new Set(["x", "y"]),
    );
  });
});

describe("SettingSecrets", () => {
  let dir: string;
  const store = () => join(dir, "server", "settings-secrets");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-setting-secrets-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes no directory until something is stored", () => {
    const secrets = new SettingSecrets(dir);
    expect(secrets.get("home", "nope")).toBeUndefined();
    secrets.prune("home", new Set());
    expect(existsSync(store())).toBe(false);
  });

  it("keeps each assistant's secrets apart, and across instances", () => {
    const first = new SettingSecrets(dir);
    const reference = first.put("home", "hunter2");
    const id = /^\$\{secret:([\w-]+)\}$/.exec(reference)?.[1];
    expect(id).toBeDefined();
    expect(existsSync(store())).toBe(true);
    const second = new SettingSecrets(dir);
    expect(second.get("home", id!)).toBe("hunter2");
    expect(second.get("work", id!)).toBeUndefined();
  });

  it("prunes what isn't kept, for that assistant only", () => {
    const secrets = new SettingSecrets(dir);
    const id = (reference: string) => [...secretReferences(reference)][0]!;
    const kept = id(secrets.put("home", "keep"));
    const dropped = id(secrets.put("home", "drop"));
    const other = id(secrets.put("work", "other"));
    secrets.prune("home", new Set([kept]));
    const reopened = new SettingSecrets(dir);
    expect(reopened.get("home", kept)).toBe("keep");
    expect(reopened.get("home", dropped)).toBeUndefined();
    expect(reopened.get("work", other)).toBe("other");
  });
});
