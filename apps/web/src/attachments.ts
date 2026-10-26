import type {
  AttachmentAdapter,
  Attachment as ComposerAttachment,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";
import {
  ATTACHMENT_IMAGE_MAX_SIDE,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_MESSAGE,
  type Attachment,
} from "@nudge/client";
import { m } from "./i18n/index.ts";

/** The image types the server takes as images (ADR 24); everything else is a file. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * What to make of an image before uploading it: how large to draw it and as which type, or
 * `undefined` to send it as it is. Photos are scaled down to `maxSide` on the long side, as
 * providers would anyway. A GIF stays as it is, since redrawing it would stop it moving; an
 * image type providers don't take, such as HEIC, becomes a JPEG so the model can see it.
 */
export function scaling(
  type: string,
  width: number,
  height: number,
  maxSide: number = ATTACHMENT_IMAGE_MAX_SIDE,
): { width: number; height: number; type: string } | undefined {
  if (type === "image/gif") return undefined;
  const known = IMAGE_TYPES.has(type);
  const scale = Math.min(1, maxSide / Math.max(width, height));
  if (known && scale === 1) return undefined;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    type: known ? type : "image/jpeg",
  };
}

/** `file` scaled down for uploading (see `scaling`); as it is when it isn't an image to redraw. */
export async function scaleImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not a picture the browser can read: it goes as a file.
    return file;
  }
  try {
    const target = scaling(file.type, bitmap.width, bitmap.height);
    if (target === undefined) return file;
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, target.type, 0.85),
    );
    if (blob === null) return file;
    const name = target.type === file.type ? file.name : `${file.name.replace(/\.[^.]*$/, "")}.jpg`;
    return new File([blob], name, { type: target.type });
  } finally {
    bitmap.close();
  }
}

/** A size for people: `240 KB`, `1.2 MB`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The composer's attachments in one room: a file is scaled down and uploaded as soon as it is
 * picked, so sending only names the ids. Removing one before sending deletes the upload. `take`
 * hands the dispatcher the uploads of a message being sent.
 */
export class RoomAttachments implements AttachmentAdapter {
  readonly accept = "*";
  private readonly uploaded = new Map<string, Attachment>();
  private readonly uploading = new Set<string>();

  constructor(
    private readonly upload: (file: File) => Promise<Attachment>,
    private readonly discard: (id: string) => Promise<void>,
  ) {}

  async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment, void> {
    const id = crypto.randomUUID();
    const base = {
      id,
      type: file.type.startsWith("image/") ? "image" : "file",
      name: file.name,
      contentType: file.type,
      file,
    } as const;
    yield { ...base, status: { type: "running", reason: "uploading", progress: 0 } };
    const failed = (message: string): PendingAttachment => ({
      ...base,
      status: { type: "incomplete", reason: "error", message },
    });
    if (this.uploaded.size + this.uploading.size >= ATTACHMENTS_PER_MESSAGE) {
      yield failed(m.room.chat.tooManyAttachments(ATTACHMENTS_PER_MESSAGE));
      return;
    }
    this.uploading.add(id);
    try {
      const scaled = await scaleImage(file);
      if (scaled.size > ATTACHMENT_MAX_BYTES) {
        yield failed(m.room.chat.attachmentTooLarge(sizeLabel(ATTACHMENT_MAX_BYTES)));
        return;
      }
      const attachment = await this.upload(scaled);
      // Removed while it was on its way: the upload goes too.
      if (!this.uploading.has(id)) {
        void this.discard(attachment.id).catch(() => {});
        return;
      }
      this.uploaded.set(id, attachment);
      yield { ...base, status: { type: "requires-action", reason: "composer-send" } };
    } catch (error) {
      yield failed((error as Error).message);
    } finally {
      this.uploading.delete(id);
    }
  }

  async remove(attachment: ComposerAttachment): Promise<void> {
    this.uploading.delete(attachment.id);
    const uploaded = this.uploaded.get(attachment.id);
    this.uploaded.delete(attachment.id);
    if (uploaded !== undefined) await this.discard(uploaded.id).catch(() => {});
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    if (!this.uploaded.has(attachment.id)) throw new Error(m.room.chat.notUploaded);
    return { ...attachment, status: { type: "complete" }, content: [] };
  }

  /** The uploads of the composer's attachments with these ids, which leave the composer's. */
  take(ids: readonly string[]): Attachment[] {
    return ids.flatMap((id) => {
      const attachment = this.uploaded.get(id);
      this.uploaded.delete(id);
      return attachment === undefined ? [] : [attachment];
    });
  }
}
