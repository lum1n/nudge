import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabaseStorage } from "../src/encrypted-storage.ts";
import { forgetEndedTasks } from "../src/ended-tasks.ts";

describe("forgetEndedTasks", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nudge-ended-"));
    file = join(dir, "nudge.db");
    // Pi Durable's own tables.
    await (await openDatabaseStorage(file)).close(BACKGROUND_CONTEXT);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (run: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(file);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  const task = (id: number, kind: string, status: string, owner?: number) =>
    write((db) => {
      db.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')").run(id);
      db.prepare(
        "INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, 1, ?, ?, 0, 0, ?)",
      ).run(id, JSON.stringify(kind), status, JSON.stringify({ id, kind, owner }));
    });
  const document = (id: number, taskId: number) =>
    write((db) => {
      db.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'document')").run(id);
      db.prepare(
        "INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) VALUES (?, '\"x.doc\"', 0, '\"\"', 'task', ?, 1, '{}')",
      ).run(id, taskId);
      db.prepare(
        "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, 1, 'base', 1, '{}')",
      ).run(id);
    });
  const ids = (sql: string) => {
    let rows: { id: number }[] = [];
    write((db) => (rows = db.prepare(sql).all() as { id: number }[]));
    return rows.map((row) => row.id);
  };

  it("keeps each owner's newest ended runs, and any with work still running", async () => {
    task(1, "x.timer", "running");
    task(10, "x.run", "terminal", 1);
    task(11, "pi.tool", "terminal", 10);
    task(12, "pi.tool", "terminal", 11);
    document(13, 11);
    task(20, "x.run", "terminal", 1);
    task(21, "pi.tool", "running", 20);
    task(30, "x.run", "terminal", 1);
    task(40, "x.run", "terminal", 1);
    task(50, "x.run", "terminal", 2);
    task(60, "x.run", "running", 1);
    task(70, "y.run", "terminal", 1);

    expect(await forgetEndedTasks(file, { "x.run": 2 })).toBe(3);
    expect(ids("SELECT id FROM tasks ORDER BY id")).toEqual([1, 20, 21, 30, 40, 50, 60, 70]);
    expect(ids("SELECT id FROM documents")).toEqual([]);
    expect(ids("SELECT document_id AS id FROM document_revisions")).toEqual([]);
    expect(ids("SELECT id FROM record_ids ORDER BY id")).toEqual([1, 20, 21, 30, 40, 50, 60, 70]);

    // Nothing more to do on the next open.
    expect(await forgetEndedTasks(file, { "x.run": 2 })).toBe(0);
  });

  it("leaves a database that doesn't exist yet alone", async () => {
    expect(await forgetEndedTasks(join(dir, "none.db"), { "x.run": 1 })).toBe(0);
  });
});
