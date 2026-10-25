import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type {
  Context as ModelContext,
  ImageContent,
  Message,
  TextContent,
} from "@earendil-works/pi-ai";
import { defineDocFamily, type Harness, type Tx } from "@earendil-works/pi-durable";

/** Largest attachment, in bytes; protocol v1's `ATTACHMENT_MAX_BYTES`. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Most attachments one message names; protocol v1's `ATTACHMENTS_PER_MESSAGE`. */
export const ATTACHMENTS_PER_MESSAGE = 8;
/** What one room's attachments may hold in all, in bytes. */
export const ROOM_ATTACHMENT_BYTES = 256 * 1024 * 1024;
/** Largest image the model is given; providers refuse bigger ones. */
export const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** How long an attachment nobody sent is kept. */
export const UNSENT_KEPT_MS = 24 * 60 * 60 * 1000;
/** Bytes per stored chunk: a multiple of 3, so the chunks' base64 joins into the whole file's. */
const CHUNK_BYTES = 192 * 1024;

/** The image types providers take; other images are files. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** An attachment as messages and the protocol show it. Stored in documents, so plain JSON. */
export type AttachmentInfo = {
  /** `a1`, `a2`, … within the room. */
  id: string;
  /** With placeholders once it is sent (ADR 9). */
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
};

export type AttachmentRecord = AttachmentInfo & {
  sha256: string;
  chunks: number;
  /** Player id. */
  uploadedBy: string;
  uploadedAt: number;
  /** When a message took it, and that message's request key, so a resend takes it again. */
  sent?: { at: number; key?: string };
  /** Sent in a private message: only this player sees it. */
  privateTo?: string;
  /** Its bytes are gone; it stays listed so its number isn't reused. */
  removed?: true;
};

type AttachmentsState = { items: AttachmentRecord[]; next: number };

/** A room's attachments, keyed by room id; their bytes are kept apart. */
export const AttachmentsDoc = defineDocFamily<AttachmentsState, null>({
  kind: "nudge.attachments",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ items: [], next: 1 }),
  // Stored whole on every change, so a removed name leaves no older revision (ADR 9).
  checkpointWhen: () => true,
});

/** One chunk of an attachment's bytes as base64, keyed `<room>/<id>/<n>`. */
export const AttachmentChunkDoc = defineDocFamily<{ data: string }, null>({
  kind: "nudge.attachment-chunk",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ data: "" }),
  checkpointWhen: () => true,
});

/** An attachment that isn't there for the caller: unknown, someone else's, or not yet sent. */
export class AttachmentNotFound extends Error {
  override name = "AttachmentNotFound";
  constructor(readonly id: string) {
    super(`No attachment "${id}"`);
  }
}

/** An attachment that was there but was removed. */
export class AttachmentRemoved extends Error {
  override name = "AttachmentRemoved";
  constructor(readonly id: string) {
    super(`Attachment "${id}" was removed`);
  }
}

/** An upload or a message the attachments refuse, such as one too big or sent already. */
export class AttachmentRefused extends Error {
  override name = "AttachmentRefused";
}

export type AttachmentUpload = {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
  /** Player id. */
  readonly by: string;
};

export type AttachmentClaim = {
  /** Player id: only the uploader sends an attachment. */
  readonly by: string;
  readonly private?: boolean;
  /** The message's request key; the same key takes the same attachments again. */
  readonly key?: string;
  /** The file name as the transcript keeps it, with placeholders. */
  readonly redactName: (name: string) => string;
};

/**
 * The files people attach to messages (ADR 24), kept in the assistant's own storage: an index per
 * room, and the bytes in chunks, so they are encrypted and backed up with everything else.
 */
export class Attachments {
  constructor(
    private readonly harness: Pick<Harness, "snapshot" | "commit">,
    private readonly now: () => number,
  ) {}

  /** Keeps an uploaded file for its uploader to send; drops the room's day-old unsent ones. */
  async add(roomId: string, upload: AttachmentUpload, context: Context): Promise<AttachmentInfo> {
    const bytes = Buffer.from(upload.bytes.buffer, upload.bytes.byteOffset, upload.bytes.length);
    if (bytes.length === 0) throw new AttachmentRefused("An attachment can't be empty");
    if (bytes.length > ATTACHMENT_MAX_BYTES)
      throw new AttachmentRefused(`An attachment is at most ${ATTACHMENT_MAX_BYTES} bytes`);
    const mime = cleanMime(upload.mime);
    const now = this.now();
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(AttachmentsDoc, roomId, null);
      for (const item of state.items)
        if (item.sent === undefined && item.removed === undefined)
          if (now - item.uploadedAt > UNSENT_KEPT_MS) await dropBytes(tx, roomId, item);
      const held = state.items.reduce((sum, item) => sum + (item.removed ? 0 : item.size), 0);
      if (held + bytes.length > ROOM_ATTACHMENT_BYTES)
        throw new AttachmentRefused("This room's attachments are full; remove some first");
      const record: AttachmentRecord = {
        id: `a${state.next}`,
        name: cleanName(upload.name),
        mime,
        size: bytes.length,
        kind: IMAGE_TYPES.has(mime) ? "image" : "file",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        chunks: Math.ceil(bytes.length / CHUNK_BYTES),
        uploadedBy: upload.by,
        uploadedAt: now,
      };
      state.next += 1;
      state.items.push({ ...record });
      for (let n = 0; n < record.chunks; n++)
        (await tx.doc(AttachmentChunkDoc, chunkKey(roomId, record.id, n), null)).data = bytes
          .subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES)
          .toString("base64");
      return infoOf(record);
    }, context);
  }

  /**
   * Marks the attachments a message is sent with, in order, and gives them as it shows them.
   * Each must be `by`'s, there, and not sent before but with the same `key`.
   */
  async claim(
    roomId: string,
    ids: readonly string[],
    claim: AttachmentClaim,
    context: Context,
  ): Promise<AttachmentInfo[]> {
    if (ids.length === 0) return [];
    if (ids.length > ATTACHMENTS_PER_MESSAGE)
      throw new AttachmentRefused(`A message has at most ${ATTACHMENTS_PER_MESSAGE} attachments`);
    if (new Set(ids).size !== ids.length)
      throw new AttachmentRefused("A message names each attachment once");
    const now = this.now();
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(AttachmentsDoc, roomId, null);
      const claimed: AttachmentInfo[] = [];
      for (const id of ids) {
        const item = state.items.find((item) => item.id === id);
        if (item === undefined || item.uploadedBy !== claim.by) throw new AttachmentNotFound(id);
        if (item.removed) throw new AttachmentRemoved(id);
        if (item.sent !== undefined) {
          if (claim.key === undefined || item.sent.key !== claim.key)
            throw new AttachmentRefused(`Attachment "${id}" was sent already`);
        } else {
          item.sent = { at: now, ...(claim.key === undefined ? {} : { key: claim.key }) };
          item.name = claim.redactName(item.name);
          if (claim.private === true) item.privateTo = claim.by;
        }
        claimed.push(infoOf(item));
      }
      return claimed;
    }, context);
  }

  /** A room's attachments, oldest first, removed ones included. */
  async list(roomId: string, context: Context): Promise<AttachmentRecord[]> {
    const state = await this.harness.snapshot(AttachmentsDoc, roomId, context);
    return JSON.parse(JSON.stringify(state?.items ?? [])) as AttachmentRecord[];
  }

  /**
   * One attachment, when `viewer` may see it: it was sent and isn't private to someone else, or
   * it is theirs and not sent yet. Without a viewer, only what nobody owns.
   */
  async get(
    roomId: string,
    id: string,
    viewer: string | undefined,
    context: Context,
  ): Promise<AttachmentRecord> {
    const item = (await this.list(roomId, context)).find((item) => item.id === id);
    if (item === undefined || !sees(item, viewer)) throw new AttachmentNotFound(id);
    if (item.removed) throw new AttachmentRemoved(id);
    return item;
  }

  /** An attachment's bytes, as `get` allows them. */
  async read(
    roomId: string,
    id: string,
    viewer: string | undefined,
    context: Context,
  ): Promise<{ info: AttachmentRecord; bytes: Buffer }> {
    const info = await this.get(roomId, id, viewer, context);
    return { info, bytes: Buffer.from(await this.base64(roomId, info, context), "base64") };
  }

  /** The bytes of an attachment, as base64, whoever may see it; for the model's requests. */
  async base64(roomId: string, info: AttachmentRecord, context: Context): Promise<string> {
    let data = "";
    for (let n = 0; n < info.chunks; n++)
      data +=
        (await this.harness.snapshot(AttachmentChunkDoc, chunkKey(roomId, info.id, n), context))
          ?.data ?? "";
    return data;
  }

  /** Drops an attachment's bytes. Only its uploader may, or anyone `admin` says may. */
  async remove(
    roomId: string,
    id: string,
    by: { readonly playerId: string; readonly admin: boolean },
    context: Context,
  ): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AttachmentsDoc, roomId, null);
      const item = state.items.find((item) => item.id === id);
      if (item === undefined || !sees(item, by.playerId)) throw new AttachmentNotFound(id);
      if (item.removed) throw new AttachmentRemoved(id);
      if (item.uploadedBy !== by.playerId && !by.admin)
        throw new AttachmentRefused("Only who attached it, or an admin, may remove it");
      await dropBytes(tx, roomId, item);
    }, context);
  }
}

function sees(item: AttachmentRecord, viewer: string | undefined): boolean {
  if (item.sent === undefined) return viewer !== undefined && viewer === item.uploadedBy;
  return item.privateTo === undefined || item.privateTo === viewer;
}

async function dropBytes(tx: Tx, roomId: string, item: AttachmentRecord): Promise<void> {
  for (let n = 0; n < item.chunks; n++)
    (await tx.doc(AttachmentChunkDoc, chunkKey(roomId, item.id, n), null)).data = "";
  item.removed = true;
}

function chunkKey(roomId: string, id: string, n: number): string {
  return `${roomId}/${id}/${n}`;
}

function infoOf({ id, name, mime, size, kind }: AttachmentInfo): AttachmentInfo {
  return { id, name, mime, size, kind };
}

function cleanName(name: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what is taken out
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  return clean.slice(0, 200) || "file";
}

function cleanMime(mime: string): string {
  const bare = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(bare) ? bare : "application/octet-stream";
}

/** Its size as people read it, such as `240 KB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The line the model reads for an attachment. */
export function attachmentLine(info: AttachmentInfo): string {
  return `[attachment ${info.id}: ${info.name}, ${info.mime}, ${formatSize(info.size)}]`;
}

/** The key on an image part that names the attachment it stands for, `<room>/<id>`. */
export const ATTACHMENT_REF = "attachment";

/** An image part that stands for an attachment, with no bytes until a request fills it in. */
export type AttachmentImagePart = ImageContent & { readonly [ATTACHMENT_REF]: string };

export function attachmentImagePart(roomId: string, info: AttachmentInfo): AttachmentImagePart {
  return { type: "image", data: "", mimeType: info.mime, [ATTACHMENT_REF]: `${roomId}/${info.id}` };
}

/** What an attachment's image part becomes in a request: the image, or a line saying why not. */
export type ResolveAttachment = (roomId: string, id: string) => Promise<ImageContent | TextContent>;

/**
 * A request with every attachment's image part filled in or replaced by `resolve`. Only user
 * messages carry them, and only `Nudge.submit` makes them, so typed text can't name one.
 */
export async function resolveAttachments(
  context: ModelContext,
  resolve: ResolveAttachment,
): Promise<ModelContext> {
  if (!context.messages.some(hasAttachmentPart)) return context;
  const messages: Message[] = [];
  for (const message of context.messages) {
    if (
      !hasAttachmentPart(message) ||
      message.role !== "user" ||
      typeof message.content === "string"
    ) {
      messages.push(message);
      continue;
    }
    const content: (TextContent | ImageContent)[] = [];
    for (const part of message.content) {
      const ref = refOf(part);
      if (ref === undefined) {
        content.push(part);
        continue;
      }
      const slash = ref.lastIndexOf("/");
      content.push(
        slash <= 0
          ? { type: "text", text: "[an attachment that can't be shown]" }
          : await resolve(ref.slice(0, slash), ref.slice(slash + 1)),
      );
    }
    messages.push({ ...message, content });
  }
  return { ...context, messages };
}

function hasAttachmentPart(message: Message): boolean {
  return (
    message.role === "user" &&
    typeof message.content !== "string" &&
    message.content.some((part) => refOf(part) !== undefined)
  );
}

function refOf(part: TextContent | ImageContent): string | undefined {
  if (part.type !== "image") return undefined;
  const ref = (part as Partial<AttachmentImagePart>)[ATTACHMENT_REF];
  return typeof ref === "string" ? ref : undefined;
}
