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

  it("keeps owners whose home is elsewhere by address, apart from the assistants here", () => {
    const owners = new ServerOwners(file);
    owners.add("robin", "ann");
    const keys = { signingKey: "sign", encryptionKey: "seal" };
    const vegard = owners.addAddress("vegard@home.example/robin", keys)!;
    expect(vegard).toMatchObject({ address: "vegard@home.example/robin", keys });
    expect(owners.addAddress("vegard@https://home.example/robin")?.id).toBe(vegard.id);
    expect(owners.addAddress("not an address")).toBeUndefined();
    const home = { server: "https://home.example", assistant: "robin", playerId: "vegard" };
    expect(owners.ownerAt(home)?.id).toBe(vegard.id);
    expect(owners.ownerAt({ ...home, playerId: "bo" })).toBeUndefined();
    owners.repin(vegard.id, { signingKey: "new", encryptionKey: "seal" });
    expect(new ServerOwners(file).ownerAt(home)?.keys?.signingKey).toBe("new");
    // Deleting the assistant Ann lives on leaves Vegard.
    expect(owners.wouldLeaveNoOwner("robin")).toBe(false);
    owners.forgetAssistant("robin");
    expect(owners.list().map((o) => o.id)).toEqual([vegard.id]);
    expect(() => owners.remove(vegard.id)).toThrow(LastOwner);
  });

  it("uses each assertion's nonce once, and forgets them once expired", () => {
    let now = 1_000;
    const owners = new ServerOwners(file, () => now);
    expect(owners.useNonce("a".repeat(16), 2_000)).toBe(true);
    expect(new ServerOwners(file, () => now).useNonce("a".repeat(16), 2_000)).toBe(false);
    now = 3_000;
    owners.useNonce("b".repeat(16), 4_000);
    expect(readFileSync(file, "utf8")).not.toContain("a".repeat(16));
  });

  it("moves owners from v0.6.0, players who joined from elsewhere, over to their address", async () => {
    // As v0.6.0 kept them: Vegard owned it through two assistants he joined, Ann lives here.
    const owners = new ServerOwners(file);
    const ann = owners.add("robin", "ann");
    const viaTeam = owners.add("team", "vegard");
    const viaCrew = owners.add("crew", "vegard");
    const { token } = owners.issue(viaCrew.id);
    const home = { server: "https://home.example", assistant: "robin", playerId: "vegard" };
    const keys = { signingKey: "sign", encryptionKey: "seal" };
    await owners.migrate(
      async (owner) => (owner.playerId === "vegard" ? home : undefined),
      async () => keys,
    );
    const moved = new ServerOwners(file);
    expect(moved.list()).toEqual([
      ann,
      { id: viaTeam.id, address: "vegard@home.example/robin", keys, addedAt: viaTeam.addedAt },
    ]);
    // Their token from before still signs in, as the one owner they are now.
    expect(moved.authenticate(token)?.owner.id).toBe(viaTeam.id);
    // Run again, nothing changes.
    await moved.migrate(
      async () => home,
      async () => keys,
    );
    expect(new ServerOwners(file).list()).toHaveLength(2);
  });
});
