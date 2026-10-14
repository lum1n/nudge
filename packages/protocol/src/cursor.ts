/**
 * Paging cursors: a JSON value as URL-safe base64, opaque to clients. Built on `btoa` and
 * `TextEncoder` rather than `Buffer`, so hosts other than Node can read them too.
 */
export function encodeCursor(value: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value)))
    binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The value in `cursor`, or undefined when it isn't one of ours. */
export function decodeCursor(cursor: string): unknown {
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}
