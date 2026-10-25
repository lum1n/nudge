import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  AttachmentNotFound,
  AttachmentRefused,
  AttachmentRemoved,
  createNudge,
  MESSAGE_ENTRY,
  type Nudge,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function open(now = () => Date.UTC(2026, 9, 25, 12)) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  faux.setResponses(
    Array.from({ length: 10 }, () => (request: ModelContext) => {
      requests.push(request);
      return fauxAssistantMessage("Seen.");
    }),
  );
  const nudge = await createNudge(
    {
      database: ":memory:",
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      now,
    },
    context,
  );
  await nudge.players.invite("Ann", context);
  await nudge.players.invite("Bo", context);
  await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
  return { nudge, requests };
}

const ann = { playerId: "ann", displayName: "Ann", clientId: "c1" };

async function send(nudge: Nudge, draft: Parameters<Nudge["submit"]>[1]) {
  await (await nudge.submit("trip", draft, context)).wait(context);
}

/** The user message's content parts of the newest request. */
function lastUserParts(requests: ModelContext[]) {
  const message = requests.at(-1)!.messages.findLast((m) => m.role === "user")!;
  return typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : message.content;
}

describe("attachments", () => {
  it("tells the model about an image, and shows it only once the room allows it", async () => {
    const { nudge, requests } = await open();
    const info = await nudge.addAttachment(
      "trip",
      { name: "receipt.png", mime: "image/png", bytes: PNG, by: "ann" },
      context,
    );
    expect(info).toEqual({
      id: "a1",
      name: "receipt.png",
      mime: "image/png",
      size: PNG.length,
      kind: "image",
    });
    await send(nudge, {
      text: "What did it cost?",
      author: ann,
      requestId: "r1",
      attachments: ["a1"],
    });

    const parts = lastUserParts(requests);
    expect(parts[0]).toMatchObject({ type: "text" });
    expect((parts[0] as { text: string }).text).toContain(
      "What did it cost?\n[attachment a1: receipt.png, image/png, 16 B]",
    );
    expect(parts[1]).toEqual({
      type: "text",
      text: "[a1 is not shown to you: this room doesn't send images to the model]",
    });

    await nudge.setImagesToModel("trip", true, context);
    expect((await nudge.rooms.get("trip", context))?.imagesToModel).toBe(true);
    await send(nudge, { text: "And now?", author: ann });
    // The earlier message's image is filled in for this request: the room allows it now.
    const earlier = requests
      .at(-1)!
      .messages.find((m) => m.role === "user" && typeof m.content !== "string")!;
    expect(earlier.content).toContainEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });

    // The timeline shows the attachment; the transcript keeps no bytes.
    const view = await (await nudge.conversation("trip", context)).context(context);
    expect(JSON.stringify(view.messages)).not.toContain(PNG.toString("base64"));
    const entries = await (
      await nudge.conversation("trip", context)
    ).entries({}, 50, undefined, context);
    const message = entries.items.find(
      (entry) =>
        entry.kind === MESSAGE_ENTRY &&
        (entry.data as { text: string }).text === "What did it cost?",
    );
    expect(message?.data).toMatchObject({ attachments: [info] });
    await nudge.close(context);
  });

  it("stops sending an image once it is removed or the room says no", async () => {
    const { nudge, requests } = await open();
    await nudge.setImagesToModel("trip", true, context);
    await nudge.addAttachment(
      "trip",
      { name: "a.png", mime: "image/png", bytes: PNG, by: "ann" },
      context,
    );
    await send(nudge, { text: "", author: ann, requestId: "r1", attachments: ["a1"] });
    expect(lastUserParts(requests)[1]).toMatchObject({ type: "image" });

    await expect(
      nudge.attachments.remove("trip", "a1", { playerId: "bo", admin: false }, context),
    ).rejects.toBeInstanceOf(AttachmentRefused);
    await nudge.attachments.remove("trip", "a1", { playerId: "ann", admin: false }, context);
    await send(nudge, { text: "Still there?", author: ann });
    const first = requests
      .at(-1)!
      .messages.find((m) => m.role === "user" && typeof m.content !== "string")!;
    expect(first.content).toContainEqual({ type: "text", text: "[a1 was removed]" });
    await expect(nudge.attachments.read("trip", "a1", "ann", context)).rejects.toBeInstanceOf(
      AttachmentRemoved,
    );
    await nudge.close(context);
  });

  it("is its uploader's until sent, and its author's alone in a private message", async () => {
    const { nudge } = await open();
    await nudge.addAttachment(
      "trip",
      { name: "kari@example.com.pdf", mime: "application/pdf", bytes: PNG, by: "ann" },
      context,
    );
    await expect(nudge.attachments.get("trip", "a1", "bo", context)).rejects.toBeInstanceOf(
      AttachmentNotFound,
    );
    // Only the uploader sends it.
    await expect(
      nudge.submit(
        "trip",
        { text: "mine", author: { playerId: "bo", displayName: "Bo" }, attachments: ["a1"] },
        context,
      ),
    ).rejects.toBeInstanceOf(AttachmentNotFound);

    await send(nudge, {
      text: "for me only",
      author: ann,
      requestId: "r1",
      private: true,
      attachments: ["a1"],
    });
    const info = await nudge.attachments.get("trip", "a1", "ann", context);
    expect(info.kind).toBe("file");
    expect(info.name).not.toContain("kari@example.com");
    expect(nudge.showTo("ann", info.name)).toBe("kari@example.com.pdf");
    expect(nudge.showTo("bo", info.name)).not.toContain("kari@example.com");
    await expect(nudge.attachments.read("trip", "a1", "bo", context)).rejects.toBeInstanceOf(
      AttachmentNotFound,
    );
    expect((await nudge.attachments.read("trip", "a1", "ann", context)).bytes).toEqual(PNG);

    // The same request again takes it again; another doesn't.
    await send(nudge, {
      text: "for me only",
      author: ann,
      requestId: "r1",
      private: true,
      attachments: ["a1"],
    });
    await expect(
      nudge.submit(
        "trip",
        { text: "again", author: ann, requestId: "r2", attachments: ["a1"] },
        context,
      ),
    ).rejects.toBeInstanceOf(AttachmentRefused);
    await nudge.close(context);
  });

  it("keeps big files whole across chunks, and drops day-old unsent ones", async () => {
    let now = Date.UTC(2026, 9, 25, 12);
    const { nudge } = await open(() => now);
    const big = randomBytes(1024 * 1024 + 7);
    await nudge.addAttachment(
      "trip",
      { name: "big.bin", mime: "application/x-thing; charset=x", bytes: big, by: "ann" },
      context,
    );
    const { info, bytes } = await nudge.attachments.read("trip", "a1", "ann", context);
    expect(info.mime).toBe("application/x-thing");
    expect(bytes.equals(big)).toBe(true);

    now += 25 * 60 * 60 * 1000;
    await nudge.addAttachment(
      "trip",
      { name: "next.png", mime: "image/png", bytes: PNG, by: "ann" },
      context,
    );
    await expect(nudge.attachments.read("trip", "a1", "ann", context)).rejects.toBeInstanceOf(
      AttachmentRemoved,
    );
    await expect(
      nudge.addAttachment(
        "trip",
        { name: "e", mime: "", bytes: new Uint8Array(), by: "ann" },
        context,
      ),
    ).rejects.toBeInstanceOf(AttachmentRefused);
    await nudge.close(context);
  });
});
