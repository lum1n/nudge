import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LastOwner, ServerOwners, serverOwnersFile } from "../src/index.ts";

describe("ServerOwners", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-owners-"));
    file = serverOwnersFile(join(dir, "nudge.json"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("keeps owners and hashed tokens in server/owners.json, read again by everyone", () => {
    const ann = new ServerOwners(file).add("robin", "ann");
    expect(new ServerOwners(file).add("robin", "ann").id).toBe(ann.id);
    const { token } = new ServerOwners(file).issue(ann.id, { name: "cli", platform: "cli" });
    expect(file).toBe(join(dir, "server", "owners.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(token);
    expect(new ServerOwners(file).authenticate(token)?.owner.id).toBe(ann.id);
    expect(new ServerOwners(file).authenticate("nudge_server_nope")).toBeUndefined();
    expect(new ServerOwners(file).authenticate("nudge_player_token")).toBeUndefined();
  });

  it("keeps the last owner, and forgets those of a deleted assistant with their tokens", () => {
    const owners = new ServerOwners(file);
    const ann = owners.add("robin", "ann");
    expect(() => owners.remove(ann.id)).toThrow(LastOwner);
    const bo = owners.add("pocket", "bo");
    const { token } = owners.issue(bo.id);
    expect(owners.wouldLeaveNoOwner("pocket")).toBe(false);
    owners.forgetAssistant("pocket");
    expect(owners.list().map((o) => o.playerId)).toEqual(["ann"]);
    expect(owners.authenticate(token)).toBeUndefined();
    expect(owners.wouldLeaveNoOwner("robin")).toBe(true);
  });
});
