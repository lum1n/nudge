import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The format of a server's data, as a number: what this release reads and writes. Bump it in a
 * release whose data an older release can't read (a changed table or document layout, a file
 * moved or re-encrypted), and say so in the release notes.
 *
 * The data directory records the format its data is in (`server/data-format`, which backups take
 * along). A release refuses data newer than it reads. One that moves the data to a newer format
 * first confirms itself, so `nudge-server` never rolls back past the move to a release that can't
 * read the result, and the server takes a backup first: going back means restoring that backup
 * with the older release.
 */
export const DATA_FORMAT = 1;

export class DataFormatError extends Error {
  override name = "DataFormatError";
}

/** Where the data directory records its format. */
export function dataFormatFile(dataDir: string): string {
  return join(dataDir, "server", "data-format");
}

/** The format the data in `dataDir` is in; data from before formats were recorded is format 1. */
export async function recordedDataFormat(dataDir: string): Promise<number> {
  const file = dataFormatFile(dataDir);
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "1";
    throw error;
  });
  const format = Number(text.trim());
  if (!Number.isSafeInteger(format) || format < 1)
    throw new DataFormatError(`${file} doesn't name a data format: ${JSON.stringify(text)}`);
  return format;
}

/**
 * Run before anything opens the data. Throws when the data is in a newer format than `format`;
 * when it is in an older one, awaits `beforeMoving` (confirm the update, take a backup), then
 * records `format`, after which the release may move the data over. Returns the format it found.
 */
export async function upgradeDataFormat(
  dataDir: string,
  options: {
    readonly format?: number;
    readonly beforeMoving?: (from: number, to: number) => Promise<void>;
  } = {},
): Promise<number> {
  const format = options.format ?? DATA_FORMAT;
  const recorded = await recordedDataFormat(dataDir);
  if (recorded > format)
    throw new DataFormatError(
      `The data in ${dataDir} is in format ${recorded}, from a newer release; this one reads ` +
        `format ${format}. Run the newer release, or restore a backup taken before it.`,
    );
  if (recorded < format) await options.beforeMoving?.(recorded, format);
  const file = dataFormatFile(dataDir);
  if (recorded < format || !existsSync(file)) {
    await mkdir(join(dataDir, "server"), { recursive: true });
    await writeFile(`${file}.tmp`, `${format}\n`);
    await rename(`${file}.tmp`, file);
  }
  return recorded;
}
