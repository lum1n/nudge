import { describe, expect, it } from "vitest";
import { type KeyValueStorage, memoryStorage, Outbox, type Outgoing } from "../src/index.ts";

const message = (requestId: string, room = "trip"): Outgoing => ({
  requestId,
  room,
  text: `Message ${requestId}`,
  createdAt: 1,
});

describe("Outbox", () => {
  it("keeps messages by room in its storage, for the next outbox on the same key", () => {
    const storage = memoryStorage();
    const outbox = new Outbox(storage, "box");
    outbox.put(message("r1"));
    outbox.put(message("r2", "lobby"));
    outbox.put(message("r3"));
    // The same request id again replaces the message rather than adding one.
    outbox.put({ ...message("r1"), text: "Edited" });
    outbox.refused("r3", "No room");

    const again = new Outbox(storage, "box");
    expect(again.list("trip")).toEqual([
      { ...message("r3"), error: "No room" },
      { ...message("r1"), text: "Edited" },
    ]);
    expect(again.list().map((m) => m.requestId)).toEqual(["r2", "r3", "r1"]);
    expect(new Outbox(storage, "other").list()).toEqual([]);

    again.remove("r3");
    again.remove("unknown");
    expect(outbox.list().map((m) => m.requestId)).toEqual(["r2", "r1"]);
    outbox.clear();
    expect(again.list()).toEqual([]);
    expect(storage.getItem("box")).toBeNull();
  });

  it("drops another player's messages when claimed", () => {
    const outbox = new Outbox(memoryStorage(), "box");
    outbox.put(message("r1"));
    // Messages sent before the first welcome are the first player's.
    outbox.claim("ann");
    expect(outbox.list()).toHaveLength(1);
    outbox.claim("ann");
    expect(outbox.list()).toHaveLength(1);
    outbox.claim("bo");
    expect(outbox.list()).toEqual([]);
  });

  it("gets by with a broken or failing storage", () => {
    const broken = memoryStorage();
    broken.setItem("box", "{not json");
    expect(new Outbox(broken, "box").list()).toEqual([]);

    const full: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const outbox = new Outbox(full, "box");
    outbox.put(message("r1"));
    outbox.clear();
    expect(outbox.list()).toEqual([]);
  });
});
