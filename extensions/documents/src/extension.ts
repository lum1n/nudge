import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily } from "@earendil-works/pi-durable";
import {
  defineNudgeExtension,
  defineTool,
  type ExtensionDocuments,
  type ExtensionHost,
  formatTime,
  roomOf,
  type RoomSocketHandler,
  section,
  Type,
} from "@nudge/core";
import { decrypt, encrypt, extractText, UnsupportedDocument } from "./text.ts";

const VERSION = "0.1.0";
/** Characters `read_document` gives at a time. */
const CHUNK = 8_000;
/** Characters of a document's text kept; the rest of a huge one isn't searched. */
const MAX_TEXT = 2_000_000;

// Stored in documents, so plain JSON.
export type DocumentInfo = {
  /** `d1`, `d2`, … within the room. */
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  pages?: number;
  chars: number;
  note?: string;
  addedBy: string;
  addedAt: number;
};

/** A room's documents, keyed by room id; their texts are kept apart, so listing stays cheap. */
export const DocumentsDoc = defineDocFamily<{ items: DocumentInfo[]; next: number }, null>({
  kind: "documents.room",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ items: [], next: 1 }),
});

/** One document's text, keyed `<room>/<id>`. */
export const DocumentTextDoc = defineDocFamily<{ text: string }, null>({
  kind: "documents.text",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ text: "" }),
});

/** What the panel socket sends. `ref` echoes the input's. */
export type PanelOutput =
  | { type: "documents"; documents: DocumentInfo[] }
  | { type: "file"; ref?: string; name: string; mime: string; data: string }
  | { type: "ok"; ref?: string; id?: string }
  | { type: "error"; message: string; ref?: string };

export type PanelInput = { ref?: string } & (
  | { type: "upload"; name: string; mime: string; data: string }
  | { type: "remove"; id: string }
  | { type: "download"; id: string }
);

const Settings = Type.Object({
  maxMegabytes: Type.Number({
    default: 20,
    minimum: 1,
    maximum: 100,
    description: "Largest file, in megabytes, that can be uploaded.",
  }),
  maxPerRoom: Type.Number({
    default: 500,
    minimum: 1,
    description: "Most documents one room may keep.",
  }),
});

/** Keeps the files, encrypted, and their texts; serves the room's Documents page. */
class Library {
  private readonly viewers = new Map<string, Set<(data: string) => void>>();
  private key: Buffer | undefined;

  constructor(
    private readonly host: Pick<
      ExtensionHost<{ maxMegabytes: number; maxPerRoom: number }>,
      "documents" | "secrets" | "dataDir" | "now" | "settings"
    >,
  ) {}

  private get documents(): ExtensionDocuments {
    return this.host.documents();
  }

  async list(roomId: string, context: Context = BACKGROUND_CONTEXT): Promise<DocumentInfo[]> {
    const state = await this.documents.snapshot(DocumentsDoc, roomId, context);
    return (JSON.parse(JSON.stringify(state?.items ?? [])) as DocumentInfo[]).reverse();
  }

  async text(roomId: string, id: string, context: Context = BACKGROUND_CONTEXT): Promise<string> {
    return (await this.documents.snapshot(DocumentTextDoc, `${roomId}/${id}`, context))?.text ?? "";
  }

  async add(
    roomId: string,
    name: string,
    mime: string,
    bytes: Buffer,
    by: string,
  ): Promise<DocumentInfo> {
    const { maxMegabytes, maxPerRoom } = this.host.settings;
    if (bytes.length > maxMegabytes * 1024 * 1024)
      throw new UnsupportedDocument(`${name} is over ${maxMegabytes} MB`);
    const clean = name.replace(/[/\\]/g, "_").trim().slice(0, 200) || "document";
    const extracted = await extractText(bytes, mime, clean);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const known = (await this.list(roomId)).find((item) => item.sha256 === sha256);
    if (known !== undefined)
      throw new UnsupportedDocument(`${clean} is here already, as ${known.id} (${known.name})`);
    const text = extracted.text.slice(0, MAX_TEXT);
    const info = await this.documents.commit(async (tx) => {
      const state = await tx.doc(DocumentsDoc, roomId, null);
      if (state.items.length >= maxPerRoom)
        throw new UnsupportedDocument(`This room has ${maxPerRoom} documents already`);
      const info: DocumentInfo = {
        id: `d${state.next}`,
        name: clean,
        mime: mime || "application/octet-stream",
        size: bytes.length,
        sha256,
        ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
        chars: text.length,
        ...(extracted.note === undefined ? {} : { note: extracted.note }),
        addedBy: by,
        addedAt: this.host.now(),
      };
      state.next += 1;
      state.items.push({ ...info });
      (await tx.doc(DocumentTextDoc, `${roomId}/${info.id}`, null)).text = text;
      return info;
    }, BACKGROUND_CONTEXT);
    await this.writeFile(roomId, info.id, bytes);
    return info;
  }

  async remove(roomId: string, id: string): Promise<void> {
    await this.documents.commit(async (tx) => {
      const state = await tx.doc(DocumentsDoc, roomId, null);
      if (!state.items.some((item) => item.id === id))
        throw new UnsupportedDocument(`No document ${id}`);
      state.items = state.items.filter((item) => item.id !== id).map((item) => ({ ...item }));
      (await tx.doc(DocumentTextDoc, `${roomId}/${id}`, null)).text = "";
    }, BACKGROUND_CONTEXT);
    const file = this.path(roomId, id);
    if (file !== undefined) await rm(file, { force: true });
  }

  async file(roomId: string, id: string): Promise<Buffer> {
    const file = this.path(roomId, id);
    if (file === undefined) throw new UnsupportedDocument("This assistant keeps no files");
    return decrypt(this.fileKey(), await readFile(file));
  }

  /** Sends the room's list to its open pages. Never fails. */
  async changed(roomId: string): Promise<void> {
    const viewers = this.viewers.get(roomId);
    if (viewers === undefined || viewers.size === 0) return;
    try {
      const frame = JSON.stringify({
        type: "documents",
        documents: await this.list(roomId),
      } satisfies PanelOutput);
      for (const send of viewers) send(frame);
    } catch {
      // The next change sends it again.
    }
  }

  readonly roomSocket: RoomSocketHandler = async ({ room, player }, socket) => {
    const send = (data: string) => socket.send(data);
    const reply = (output: PanelOutput) => socket.send(JSON.stringify(output));
    let viewers = this.viewers.get(room.id);
    if (viewers === undefined) this.viewers.set(room.id, (viewers = new Set()));
    viewers.add(send);
    reply({ type: "documents", documents: await this.list(room.id) });
    let queue = Promise.resolve();
    return {
      receive: (data) => {
        queue = queue.then(async () => {
          let input: PanelInput;
          try {
            input = JSON.parse(data) as PanelInput;
          } catch {
            return reply({ type: "error", message: "Frames are JSON" });
          }
          const ref = typeof input.ref === "string" ? { ref: input.ref } : {};
          try {
            if (input.type === "upload") {
              const info = await this.add(
                room.id,
                String(input.name),
                String(input.mime ?? ""),
                Buffer.from(String(input.data), "base64"),
                player.displayName,
              );
              reply({ type: "ok", ...ref, id: info.id });
              await this.changed(room.id);
            } else if (input.type === "remove") {
              await this.remove(room.id, String(input.id));
              reply({ type: "ok", ...ref });
              await this.changed(room.id);
            } else if (input.type === "download") {
              const info = (await this.list(room.id)).find((item) => item.id === input.id);
              if (info === undefined) throw new UnsupportedDocument(`No document ${input.id}`);
              const bytes = await this.file(room.id, info.id);
              reply({
                type: "file",
                ...ref,
                name: info.name,
                mime: info.mime,
                data: bytes.toString("base64"),
              });
            } else throw new UnsupportedDocument("Unknown input");
          } catch (error) {
            reply({ type: "error", message: (error as Error).message, ...ref });
          }
        });
      },
      close: () => {
        viewers.delete(send);
        if (viewers.size === 0) this.viewers.delete(room.id);
      },
    };
  };

  private path(roomId: string, id: string): string | undefined {
    return this.host.dataDir === undefined
      ? undefined
      : join(this.host.dataDir, "files", roomId, id);
  }

  private async writeFile(roomId: string, id: string, bytes: Buffer): Promise<void> {
    const file = this.path(roomId, id);
    if (file === undefined) return;
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await writeFile(file, encrypt(this.fileKey(), bytes), { mode: 0o600 });
  }

  /** The key the files are encrypted with, kept with the extension's other secrets. */
  private fileKey(): Buffer {
    if (this.key !== undefined) return this.key;
    let stored = this.host.secrets.get("files", "key");
    if (stored === undefined) {
      stored = randomBytes(32).toString("base64");
      this.host.secrets.set("files", "key", stored);
    }
    this.key = Buffer.from(stored, "base64");
    return this.key;
  }
}

/** Every word of the query, scored by how often it appears; names count five times. */
export function searchTexts(
  documents: readonly { readonly info: DocumentInfo; readonly text: string }[],
  query: string,
  limit: number,
): { info: DocumentInfo; score: number; snippet: string }[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  const count = (haystack: string, term: string) => haystack.split(term).length - 1;
  const scored = documents.map(({ info, text }) => {
    const lower = text.toLowerCase();
    const name = info.name.toLowerCase();
    const hits = terms.map((term) => count(lower, term) + 5 * count(name, term));
    return { info, text, lower, hits, score: hits.reduce((a, b) => a + b, 0) };
  });
  // Every word if any document has them all; else any word.
  const all = scored.filter((doc) => doc.hits.every((hit) => hit > 0));
  return (all.length > 0 ? all : scored.filter((doc) => doc.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ info, text, lower, score }) => {
      const at = Math.max(
        0,
        Math.min(...terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0)),
      );
      const start = Math.max(0, at - 80);
      const snippet = text
        .slice(start, at + 160)
        .replace(/\s+/g, " ")
        .trim();
      return {
        info,
        score,
        snippet: `${start > 0 ? "…" : ""}${snippet}${at + 160 < text.length ? "…" : ""}`,
      };
    });
}

export const documentsExtension = defineNudgeExtension({
  name: "documents",
  version: VERSION,
  description:
    "Documents and receipts per room: uploaded, their text extracted and searched on the host.",
  settings: Settings,
  setup: (host) => {
    const library = new Library(host);
    const text = (value: string, isError = false) => ({
      output: [{ type: "text" as const, text: value }],
      ...(isError ? { isError } : {}),
    });
    const describe = (info: DocumentInfo) =>
      `${info.id}  ${info.name}` +
      ` (${info.pages === undefined ? "" : `${info.pages} pages, `}${info.chars} characters` +
      `${info.note === undefined ? "" : `; ${info.note}`})` +
      ` — added ${formatTime(info.addedAt, host.timeZone)} by ${info.addedBy}`;

    const list = defineTool({
      name: "list_documents",
      description: "List the documents people have uploaded to this conversation, newest first.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const items = await library.list(room.id, context);
        return text(
          items.length === 0
            ? "No documents yet; people upload them on the room's Documents page."
            : items.map(describe).join("\n"),
        );
      },
    });

    const search = defineTool({
      name: "search_documents",
      description:
        "Search the text of this conversation's documents (receipts, contracts, letters, " +
        "warranties) by words in them or their names. Gives each match's id for read_document.",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Number({ description: "Default 5, up to 20." })),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const items = await library.list(room.id, context);
        const documents = await Promise.all(
          items.map(async (info) => ({
            info,
            text: await library.text(room.id, info.id, context),
          })),
        );
        const found = searchTexts(
          documents,
          args.query,
          Math.min(Math.max(1, args.limit ?? 5), 20),
        );
        return text(
          found.length === 0
            ? "No document matches."
            : found.map(({ info, snippet }) => `${info.id}  ${info.name}\n  ${snippet}`).join("\n"),
        );
      },
    });

    const read = defineTool({
      name: "read_document",
      description: `Read a document's text, ${CHUNK} characters at a time from \`offset\`.`,
      parameters: Type.Object({
        id: Type.String(),
        offset: Type.Optional(Type.Number({ description: "Character to start at; default 0." })),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const info = (await library.list(room.id, context)).find((item) => item.id === args.id);
        if (info === undefined) return text(`No document ${args.id} here.`, true);
        const all = await library.text(room.id, info.id, context);
        if (all === "")
          return text(
            `${info.name} has no text${info.note === undefined ? "" : `: ${info.note}`}.`,
          );
        const offset = Math.max(0, Math.floor(args.offset ?? 0));
        const part = all.slice(offset, offset + CHUNK);
        const more = offset + CHUNK < all.length;
        return text(
          `${info.name}, characters ${offset}–${offset + part.length} of ${all.length}:\n\n${part}` +
            (more ? `\n\n…more from offset ${offset + CHUNK}.` : ""),
        );
      },
    });

    return {
      tools: [list, search, read],
      roomSocket: library.roomSocket,
      sections: [
        section("documents", async (input, context) => {
          const room = await roomOf(input.read, input.conversationId, context).catch(
            () => undefined,
          );
          if (room === undefined) return undefined;
          const count =
            (await input.read.snapshot(DocumentsDoc, room.id, context))?.items.length ?? 0;
          if (count === 0) return undefined;
          return `This conversation has ${count} uploaded document${count === 1 ? "" : "s"} (receipts, letters and the like): search_documents and read_document find what's in them.`;
        }),
      ],
    };
  },
});

export default documentsExtension;
