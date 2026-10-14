import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ClientFrame, ServerFrame } from "../src/index.ts";
import { schemaDocument } from "../src/schema-document.ts";

describe("schema", () => {
  it("schema/v1.json is up to date (pnpm -C packages/protocol schema)", async () => {
    const written = await readFile(new URL("../schema/v1.json", import.meta.url), "utf8");
    expect(JSON.parse(written)).toEqual(JSON.parse(schemaDocument()));
  });

  it("tells good frames from bad ones", () => {
    const hello = {
      type: "hello",
      protocol: 1,
      token: "t",
      client: { name: "ios", version: "1.0", platform: "ios" },
    };
    expect(Value.Check(ClientFrame, hello)).toBe(true);
    expect(Value.Check(ClientFrame, { ...hello, protocol: 2 })).toBe(false);
    expect(Value.Check(ClientFrame, { type: "subscribe", target: "room:trip" })).toBe(true);
    expect(Value.Check(ClientFrame, { type: "subscribe", target: "rooms" })).toBe(false);
    expect(
      Value.Check(ServerFrame, {
        type: "patch",
        target: "home",
        seq: 3,
        ops: [{ op: "append", path: ["timeline", 0, "parts", 1, "text"], text: "lo" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(ServerFrame, { type: "patch", target: "home", seq: 3, ops: [{ op: "move" }] }),
    ).toBe(false);
  });
});
