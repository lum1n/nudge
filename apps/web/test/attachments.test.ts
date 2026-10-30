import type { Attachment } from "@nudge/client";
import { describe, expect, it } from "vitest";
import { RoomAttachments, scaling, sizeLabel } from "../src/attachments.ts";

describe("scaling", () => {
  it("scales photos down to 2048 pixels on the long side, keeping their type", () => {
    expect(scaling("image/jpeg", 4032, 3024)).toEqual({
      width: 2048,
      height: 1536,
      type: "image/jpeg",
    });
    expect(scaling("image/png", 1000, 5000)).toEqual({
      width: 410,
      height: 2048,
      type: "image/png",
    });
  });

  it("leaves small images and GIFs as they are, and makes other image types JPEGs", () => {
    expect(scaling("image/webp", 800, 600)).toBeUndefined();
    expect(scaling("image/gif", 4000, 4000)).toBeUndefined();
    expect(scaling("image/heic", 800, 600)).toEqual({
      width: 800,
      height: 600,
      type: "image/jpeg",
    });
  });
});

describe("sizeLabel", () => {
  it("says sizes in B, KB and MB", () => {
    expect(sizeLabel(900)).toBe("900 B");
    expect(sizeLabel(240 * 1024)).toBe("240 KB");
    expect(sizeLabel(1.25 * 1024 * 1024)).toBe("1.3 MB");
  });
});

describe("RoomAttachments", () => {
  const uploaded = (name: string): Attachment => ({
    id: `a-${name}`,
    name,
    mime: "text/plain",
    size: 1,
    kind: "file",
  });

  async function states(adapter: RoomAttachments, file: File) {
    const seen = [];
    for await (const state of adapter.add({ file })) seen.push(state);
    return seen;
  }

  it("uploads a file once it is picked, and hands it over when the message goes", async () => {
    const adapter = new RoomAttachments(
      async (file) => uploaded(file.name),
      async () => {},
    );
    const seen = await states(adapter, new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(seen.map((state) => state.status.type)).toEqual(["running", "requires-action"]);
    const id = seen[0]!.id;
    expect(await adapter.send(seen[1]!)).toMatchObject({ id, status: { type: "complete" } });
    expect(adapter.take([id])).toEqual([uploaded("notes.txt")]);
    expect(adapter.take([id])).toEqual([]);
  });

  it("deletes the upload of one taken off before sending", async () => {
    const discarded: string[] = [];
    const adapter = new RoomAttachments(
      async (file) => uploaded(file.name),
      async (id) => void discarded.push(id),
    );
    const seen = await states(adapter, new File(["x"], "notes.txt"));
    await adapter.remove(seen[1]!);
    expect(discarded).toEqual(["a-notes.txt"]);
    expect(adapter.take([seen[1]!.id])).toEqual([]);
  });

  it("says why an upload failed", async () => {
    const adapter = new RoomAttachments(
      async () => {
        throw new Error("The room's attachments are full");
      },
      async () => {},
    );
    const seen = await states(adapter, new File(["x"], "big.bin"));
    expect(seen.at(-1)?.status).toEqual({
      type: "incomplete",
      reason: "error",
      message: "The room's attachments are full",
    });
  });
});
