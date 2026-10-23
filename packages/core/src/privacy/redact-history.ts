import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { ApprovalsDoc } from "../approvals/approvals.ts";
import { openRawDatabase } from "../encrypted-storage.ts";
import { DirectoryDoc } from "../identity/directory.ts";
import { MemoryDoc, PlayerMemoryDoc } from "../memory/memory.ts";
import type { Nudge, NudgeOptions } from "../nudge.ts";
import { ScheduleDoc } from "../nudges/schedule.ts";
import { mapStrings } from "./redact.ts";

/** What `redactHistory` changed. */
export type RedactedHistory = {
  readonly entries: number;
  readonly documents: number;
};

/** Entry data fields that hold what someone wrote, by entry kind; the rest is ids and names. */
const TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "nudge.message": ["text"],
  "nudge.fire": ["message"],
  "nudge.approval": ["summary"],
};

/**
 * Stores an assistant's history with placeholders, as Nudge has since ADR 9, for a database from
 * before: every transcript entry, and the memory, approvals and nudges as they are now. Values the
 * detectors find go to the vault on the way. Needs the database to itself; the file is vacuumed
 * after, so the old text isn't left in free pages.
 */
export async function redactHistory(
  options: NudgeOptions,
  open: (options: NudgeOptions, context: Context) => Promise<Nudge>,
  context: Context,
): Promise<RedactedHistory> {
  if (options.database === ":memory:") return { entries: 0, documents: 0 };
  const nudge = await open(options, context);
  let documents: number;
  const changed: { id: number; record: string }[] = [];
  try {
    documents = await redactDocuments(nudge, context);
    // Read beside the open assistant; written once it has closed, so its caches can't go stale.
    const raw = await openRawDatabase(options.database);
    try {
      const rows = raw.all("SELECT id, record FROM entries ORDER BY id") as {
        id: number;
        record: string;
      }[];
      // A value found in a later entry may be written out in earlier ones: go again until the
      // vault stops growing.
      for (let pass = 0; pass < 3; pass++) {
        const before = nudge.vaultVersion;
        changed.length = 0;
        for (const row of rows) {
          const record = JSON.parse(row.record) as EntryJson;
          const redacted = JSON.stringify(redactEntry(record, (text) => nudge.redact(text)));
          if (redacted !== row.record) changed.push({ id: row.id, record: redacted });
        }
        if (nudge.vaultVersion === before) break;
      }
    } finally {
      raw.close();
    }
    // Values found on the way are in the vault before anything stops needing them.
    await nudge.saveVault();
  } finally {
    await nudge.close(context);
  }
  if (changed.length > 0) {
    const raw = await openRawDatabase(options.database);
    try {
      raw.exec("BEGIN");
      for (const { id, record } of changed)
        raw.run("UPDATE entries SET record = ? WHERE id = ?", record, id);
      raw.exec("COMMIT");
      raw.exec("VACUUM");
    } finally {
      raw.close();
    }
  }
  return { entries: changed.length, documents };
}

/**
 * Goes up when the detectors find more, so history stored before is rewritten once: 2 added
 * places, organisations, hosts, user names, plates and the rest (ADR 14), and drops thinking that
 * held values.
 */
export const REDACTION_VERSION = 2;

/**
 * Rewrites an assistant's history with today's detectors when it was stored under older ones, so
 * what they find now is out of the database too, not only out of requests. The version is kept in
 * a file beside the database. Needs the database to itself.
 */
export async function redactWhenOutdated(
  options: NudgeOptions,
  open: (options: NudgeOptions, context: Context) => Promise<Nudge>,
  context: Context,
): Promise<RedactedHistory | undefined> {
  // Only a database file can be rewritten: not one in memory, nor storage a host brings, such as
  // a Durable Object's.
  if (options.database === ":memory:" || options.storage !== undefined) return undefined;
  const marker = `${options.database}.redaction`;
  const stored = existsSync(marker) ? Number((await readFile(marker, "utf8")).trim()) : 0;
  if (stored >= REDACTION_VERSION) return undefined;
  const done = existsSync(options.database)
    ? await redactHistory(options, open, context)
    : { entries: 0, documents: 0 };
  // A new database's directory may not be there yet; opening it makes the same one.
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, `${REDACTION_VERSION}\n`, { mode: 0o600 });
  return done;
}

type EntryJson = {
  kind?: string;
  data?: Record<string, JsonValue>;
  model?: Message[];
  [key: string]: unknown;
};

function redactEntry(record: EntryJson, redact: (text: string) => string): EntryJson {
  const fields = TEXT_FIELDS[record.kind ?? ""] ?? [];
  const data =
    record.data === undefined || fields.length === 0
      ? record.data
      : Object.fromEntries(
          Object.entries(record.data).map(([key, value]) => [
            key,
            fields.includes(key) ? mapStrings(value, redact) : value,
          ]),
        );
  return {
    ...record,
    ...(data === undefined ? {} : { data }),
    ...(record.model === undefined ? {} : { model: redactMessages(record.model, redact) }),
  };
}

/**
 * The same walk as requests get (`redactContext`): text, tool calls and results. Thinking that
 * held a value is stored redacted and loses its signature, so it is never replayed to a provider.
 */
function redactMessages(messages: Message[], redact: (text: string) => string): Message[] {
  const text = <T extends { type: string }>(blocks: readonly T[]): T[] =>
    blocks.map((block) =>
      block.type === "text"
        ? { ...block, text: redact((block as unknown as { text: string }).text) }
        : block,
    );
  return messages.map((message): Message => {
    switch (message.role) {
      case "system":
        return {
          ...message,
          content:
            typeof message.content === "string" ? redact(message.content) : text(message.content),
          ...(message.sections === undefined
            ? {}
            : {
                sections: Object.fromEntries(
                  Object.entries(message.sections).map(([key, value]) => [
                    key,
                    value === null ? null : redact(value),
                  ]),
                ),
              }),
        };
      case "user":
        return {
          ...message,
          content:
            typeof message.content === "string" ? redact(message.content) : text(message.content),
        };
      case "assistant":
        return {
          ...message,
          content: message.content.map((block) =>
            block.type === "text"
              ? { ...block, text: redact(block.text) }
              : block.type === "toolCall"
                ? { ...block, arguments: mapStrings(block.arguments, redact) }
                : block.type === "thinking" && !block.redacted
                  ? redactThinking(block, redact)
                  : block,
          ),
        };
      case "toolResult":
        return {
          ...message,
          content: text(message.content),
          ...(message.details === undefined
            ? {}
            : { details: mapStrings(message.details, redact) }),
        } as Message;
    }
  });
}

function redactThinking<T extends { thinking: string; thinkingSignature?: string }>(
  block: T,
  redact: (text: string) => string,
): T {
  const thinking = redact(block.thinking);
  if (thinking === block.thinking) return block;
  const { thinkingSignature: _, ...rest } = block;
  return { ...rest, thinking } as T;
}

/** Memory, approvals and pending nudges, rewritten with placeholders. Returns how many changed. */
async function redactDocuments(nudge: Nudge, context: Context): Promise<number> {
  const redact = (text: string) => nudge.redact(text);
  const directory = await nudge.harness.snapshot(DirectoryDoc, context);
  const rooms = Object.keys(directory?.rooms ?? {});
  const players = Object.keys(directory?.players ?? {});
  return nudge.harness.commit(async (tx) => {
    let count = 0;
    const note = (before: string, after: string) => {
      if (before !== after) count++;
      return after;
    };
    for (const roomId of rooms) {
      const memory = await tx.doc(MemoryDoc, roomId, null);
      for (const fact of memory.facts) fact.text = note(fact.text, redact(fact.text));
      const approvals = await tx.doc(ApprovalsDoc, roomId, null);
      for (const approval of approvals.items) {
        approval.summary = note(approval.summary, redact(approval.summary));
        if (approval.result !== undefined)
          approval.result = note(approval.result, redact(approval.result));
        const payload = mapStrings(approval.payload, redact);
        if (JSON.stringify(payload) !== JSON.stringify(approval.payload)) {
          approval.payload = payload;
          count++;
        }
      }
    }
    for (const playerId of players) {
      const memory = await tx.doc(PlayerMemoryDoc, playerId, null);
      for (const fact of memory.facts) fact.text = note(fact.text, redact(fact.text));
    }
    const schedule = await tx.doc(ScheduleDoc);
    for (const nudge of Object.values(schedule.nudges))
      nudge.message = note(nudge.message, redact(nudge.message));
    return count;
  }, context);
}
