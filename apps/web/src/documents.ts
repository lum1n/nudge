import { type PanelSocket, type PanelSocketState, usePanelSocket } from "./panel-socket.ts";

/** A document as the panel shows it (`DocumentInfo` in `@nudge/ext-documents`). */
export type DocumentInfo = {
  id: string;
  name: string;
  mime: string;
  size: number;
  pages?: number;
  chars: number;
  note?: string;
  addedBy: string;
  addedAt: number;
};

export type DocumentsInput =
  | { type: "upload"; name: string; mime: string; data: string }
  | { type: "remove"; id: string }
  | { type: "download"; id: string };

type DocumentsFrame =
  | { type: "documents"; documents: DocumentInfo[] }
  | { type: "file"; ref?: string; name: string; mime: string; data: string };

export type DocumentsSocket = PanelSocket<DocumentInfo[], DocumentsInput, DocumentsFrame>;

/** One room's documents, kept current by the server. */
export function useDocuments(
  assistant: string,
  room: string,
): [DocumentsSocket | undefined, PanelSocketState<DocumentInfo[]>] {
  return usePanelSocket<DocumentInfo[], DocumentsInput, DocumentsFrame>(
    assistant,
    room,
    "documents",
    (frame) => (frame.type === "documents" ? frame.documents : undefined),
  );
}

/** A file's bytes as base64, for the socket. */
export async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Hands base64 bytes to the browser as a download. */
export function save(name: string, mime: string, data: string): void {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
