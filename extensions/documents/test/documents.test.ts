import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  createNudge,
  LOBBY,
  type ModelContext,
  type Nudge,
  untrustedData,
} from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentsExtension, extractText, type PanelOutput, searchTexts } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/** A small PDF with one line of Helvetica text per page, cross-reference table and all. */
function pdf(pages: readonly string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [i, text] of pages.entries()) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

describe("text extraction", () => {
  it("reads a PDF's text page by page, and text files as they are", async () => {
    const extracted = await extractText(
      pdf(["Receipt: dishwasher, 2 year warranty", "Paid 6 990 kr"]),
      "application/pdf",
      "receipt.pdf",
    );
    expect(extracted).toEqual({
      text: "[page 1]\nReceipt: dishwasher, 2 year warranty\n\n[page 2]\nPaid 6 990 kr",
      pages: 2,
    });
    expect(await extractText(Buffer.from("Hei på deg"), "", "note.txt")).toEqual({
      text: "Hei på deg",
    });
    expect((await extractText(Buffer.from([0xff, 0xd8]), "image/jpeg", "a.jpg")).note).toMatch(
      /image/,
    );
    await expect(extractText(Buffer.from("x"), "application/zip", "a.zip")).rejects.toThrow(
      /only PDF/,
    );
  });

  it("ranks documents with every word first, names counting most", () => {
    const doc = (id: string, name: string) => ({
      id,
      name,
      mime: "text/plain",
      size: 1,
      sha256: id,
      chars: 1,
      addedBy: "Ann",
      addedAt: 0,
    });
    const found = searchTexts(
      [
        { info: doc("d1", "insurance.pdf"), text: "Home insurance covers water damage." },
        { info: doc("d2", "dishwasher warranty.pdf"), text: "Warranty: 2 years from purchase." },
        { info: doc("d3", "letter.txt"), text: "The warranty letter is lost." },
      ],
      "warranty dishwasher",
      5,
    );
    expect(found.map((f) => f.info.id)).toEqual(["d2"]);
    expect(searchTexts([{ info: doc("d1", "a"), text: "water" }], "warranty", 5)).toEqual([]);
  });
});

describe("documents", () => {
  let dir: string;
  let nudge: Nudge;
  let requests: ModelContext[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-docs-"));
    requests = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      requests.push(request);
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([
          fauxText(last.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
        ]);
      const message = request.messages.findLast((m) => m.role === "user");
      const text =
        typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
      const file = /file (a\d+)/.exec(text);
      if (file !== null)
        return fauxAssistantMessage([fauxToolCall("save_attachment", { id: file[1]! })], {
          stopReason: "toolUse",
        });
      if (text.includes("which documents"))
        return fauxAssistantMessage([fauxToolCall("list_documents", {})], {
          stopReason: "toolUse",
        });
      if (text.includes("warranty"))
        return fauxAssistantMessage(
          [fauxToolCall("search_documents", { query: "dishwasher warranty" })],
          { stopReason: "toolUse" },
        );
      if (text.includes("read it"))
        return fauxAssistantMessage([fauxToolCall("read_document", { id: "d1" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 50 }, () => answer));
    nudge = await createNudge(
      {
        database: join(dir, "a.sqlite"),
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [documentsExtension],
      },
      context,
    );
    await nudge.players.invite("Ann", context);
    await nudge.players.invite("Bo", context);
  });

  afterEach(async () => {
    await nudge.close(context);
    await rm(dir, { recursive: true, force: true });
  });

  const say = async (text: string) => {
    const author = { playerId: "ann", displayName: "Ann" };
    const settled = await (await nudge.submit(LOBBY, { text, author }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
    const last = requests.at(-1)!.messages.findLast((m) => m.role === "toolResult");
    return last?.role === "toolResult"
      ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : "";
  };

  /** The room's Documents page, through the extension's socket, one input at a time. */
  const openPage = async () => {
    const frames: PanelOutput[] = [];
    const room = (await nudge.rooms.get(LOBBY, context))!;
    const player = (await nudge.players.get("ann", context))!;
    const session = await nudge.roomSocket("documents")!(
      { room, player, admin: false },
      { send: (data) => frames.push(JSON.parse(data) as PanelOutput), close: () => {} },
    );
    let ref = 0;
    const send = async (input: object) => {
      const id = String(++ref);
      session.receive(JSON.stringify({ ...input, ref: id }));
      const end = Date.now() + 5_000;
      for (;;) {
        const reply = frames.find((f) => "ref" in f && f.ref === id);
        if (reply !== undefined) return reply;
        if (Date.now() > end) throw new Error("No reply");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const listed = () =>
      (
        frames.filter((f) => f.type === "documents").at(-1) as Extract<
          PanelOutput,
          { type: "documents" }
        >
      ).documents;
    return { send, listed, session };
  };

  it("takes uploads, keeps the files encrypted, and lets the model find what's in them", async () => {
    const page = await openPage();
    const receipt = pdf([
      "Elkjop receipt: dishwasher Bosch, 2 year warranty",
      "Paid 6990 kr on 12.03.2026",
    ]);
    const upload = (name: string, mime: string, bytes: Buffer) =>
      page.send({ type: "upload", name, mime, data: bytes.toString("base64") });

    expect(await upload("dishwasher receipt.pdf", "application/pdf", receipt)).toMatchObject({
      type: "ok",
      id: "d1",
    });
    expect(
      await upload("notes.txt", "text/plain", Buffer.from("Ring rørleggeren om lekkasjen")),
    ).toMatchObject({ id: "d2" });
    expect(await upload("again.pdf", "application/pdf", receipt)).toMatchObject({
      type: "error",
      message: "again.pdf is here already, as d1 (dishwasher receipt.pdf)",
    });
    expect(page.listed().map((d) => [d.id, d.name, d.pages, d.addedBy])).toEqual([
      ["d2", "notes.txt", undefined, "Ann"],
      ["d1", "dishwasher receipt.pdf", 2, "Ann"],
    ]);

    // On disk only encrypted; the page downloads the original.
    const files = join(dir, "a.sqlite.extensions", "documents", "files", LOBBY);
    expect((await readdir(files)).sort()).toEqual(["d1", "d2"]);
    expect((await readFile(join(files, "d1"))).includes(Buffer.from("dishwasher"))).toBe(false);
    const download = await page.send({ type: "download", id: "d1" });
    expect(download.type === "file" && Buffer.from(download.data, "base64").equals(receipt)).toBe(
      true,
    );

    // Anyone could have written a document: the model gets it as untrusted data.
    expect(await say("which documents do we have?")).toMatch(
      /^<untrusted-data source="list_documents">\nd2 {2}notes\.txt \(29 characters\)/,
    );
    expect(await say("Where's the dishwasher warranty?")).toBe(
      untrustedData(
        "search_documents",
        "d1  dishwasher receipt.pdf\n  [page 1] Elkjop receipt: dishwasher Bosch, 2 year warranty [page 2] Paid 6990 kr on 12.03.2026",
      ),
    );
    expect(await say("read it")).toContain("Paid 6990 kr on 12.03.2026");

    expect(await page.send({ type: "remove", id: "d1" })).toMatchObject({ type: "ok" });
    expect(await readdir(files)).toEqual(["d2"]);
    expect(page.listed().map((d) => d.id)).toEqual(["d2"]);
    page.session.close();
  });

  it("files an attachment the turn's person may see as a document", async () => {
    const ann = { playerId: "ann", displayName: "Ann" };
    const bo = { playerId: "bo", displayName: "Bo" };
    const send = async (
      author: typeof ann,
      text: string,
      attachments: string[] = [],
      secret = false,
    ) => {
      await (
        await nudge.submit(
          LOBBY,
          { text, author, attachments, ...(secret ? { private: true } : {}) },
          context,
        )
      ).wait(context);
      const last = requests.at(-1)!.messages.findLast((m) => m.role === "toolResult");
      return last?.role === "toolResult"
        ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        : "";
    };
    const attach = (name: string, body: string, by: string) =>
      nudge.addAttachment(
        LOBBY,
        { name, mime: "text/plain", bytes: Buffer.from(body), by },
        context,
      );

    await attach("warranty.txt", "Dishwasher warranty until 2028", "ann");
    // Not sent yet: Ann's alone, so a turn for Bo doesn't get it.
    expect(await send(bo, "file a1")).toBe("No attachment a1 here.");
    expect(await send(ann, "file a1 please", ["a1"])).toMatch(
      /^Saved a1 among the documents: d1 {2}warranty\.txt \(30 characters\) — added .* by Ann\.$/,
    );
    expect(await say("Where's the dishwasher warranty?")).toContain("d1  warranty.txt");

    await attach("secret.txt", "Only mine", "ann");
    expect(await send(ann, "file a2", ["a2"], true)).toMatch(/^a2 was sent privately/);
    expect(await send(ann, "file a1")).toMatch(/is here already, as d1/);
    await nudge.attachments.remove(LOBBY, "a1", { playerId: "ann", admin: false }, context);
    expect(await send(ann, "file a1")).toBe("Attachment a1 was removed.");
  });
});
