import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Extracted = {
  readonly text: string;
  readonly pages?: number;
  /** Why there is no text, such as for an image. */
  readonly note?: string;
};

export class UnsupportedDocument extends Error {
  override name = "UnsupportedDocument";
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-ndjson)$|message\/rfc822$)/;
const TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|xml|html?|eml|ics|vcf|log)$/i;

/** The kind of a file, from its type or else its name. */
export function kindOf(mime: string, name: string): "pdf" | "text" | "image" | undefined {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/i.test(name)) return "image";
  if (TEXT_TYPES.test(mime) || TEXT_NAMES.test(name)) return "text";
  return undefined;
}

/** The text of a file, read on the host. Images give none: reading them would mean sending them out. */
export async function extractText(
  bytes: Uint8Array,
  mime: string,
  name: string,
): Promise<Extracted> {
  switch (kindOf(mime, name)) {
    case "pdf":
      return extractPdf(bytes);
    case "text": {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return { text: /\.html?$/i.test(name) || mime === "text/html" ? stripTags(text) : text };
    }
    case "image":
      return { text: "", note: "an image; its text isn't read, so it stays on the host" };
    default:
      throw new UnsupportedDocument(
        `${name}: only PDF, text files and images are taken (this is ${mime || "unknown"})`,
      );
  }
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const pdf = await loading.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
      pages.push(
        text
          .replace(/[ \t]+\n/g, "\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim(),
      );
      page.cleanup();
    }
    const text = pages
      .map((page, i) => (pdf.numPages > 1 ? `[page ${i + 1}]\n${page}` : page))
      .join("\n\n");
    return {
      text,
      pages: pdf.numPages,
      ...(text.replace(/\[page \d+\]/g, "").trim() === ""
        ? { note: "a PDF without a text layer, such as a scan; its text isn't read" }
        : {}),
    };
  } finally {
    await loading.destroy();
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** AES-256-GCM: a fresh 12-byte nonce, then the tag, then the ciphertext. */
export function encrypt(key: Buffer, plain: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), sealed]);
}

export function decrypt(key: Buffer, data: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}
