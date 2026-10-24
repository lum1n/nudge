import { existsSync } from "node:fs";
import { openRawDatabase, type RawDatabase } from "./encrypted-storage.ts";

type TaskRow = { id: number; status: string; owner: number | null };

/**
 * Deletes ended tasks of some kinds, past the newest few of each owner, with the tasks they owned
 * and those tasks' documents. Pi Durable keeps every task's record for good, and its documents'
 * rows once retired, so a timer that starts a task on each check, as a watch running a script
 * does, would add to the file every few minutes for as long as it runs. A task still running
 * below one keeps it. Needs the database to itself. Returns how many tasks it deleted, owned
 * ones included.
 */
export async function forgetEndedTasks(
  database: string,
  keep: Readonly<Record<string, number>>,
): Promise<number> {
  const kinds = Object.entries(keep);
  if (kinds.length === 0 || !existsSync(database)) return 0;
  const raw = await openRawDatabase(database);
  try {
    if (
      raw.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").length === 0
    )
      return 0;
    const old: number[] = [];
    for (const [kind, newest] of kinds) {
      const kept = new Map<number | null, number>();
      // The newest first: an owner may still be waiting for its latest.
      for (const task of tasks(raw, "kind = ? ORDER BY id DESC", JSON.stringify(kind))) {
        if (task.status !== "terminal") continue;
        const count = kept.get(task.owner) ?? 0;
        if (count < Math.max(1, newest)) kept.set(task.owner, count + 1);
        else old.push(task.id);
      }
    }
    if (old.length === 0) return 0;

    // A task is made after its owner, so whatever the old ones owned comes after the first.
    const owned = new Map<number, TaskRow[]>();
    for (const task of tasks(raw, "id > ? ORDER BY id", Math.min(...old))) {
      if (task.owner === null) continue;
      const siblings = owned.get(task.owner) ?? [];
      siblings.push(task);
      owned.set(task.owner, siblings);
    }
    const ownsConversation = (id: number) =>
      raw.all("SELECT 1 FROM conversations WHERE owner_task_id = ? LIMIT 1", id).length > 0;
    const doomed: number[] = [];
    for (const id of old) {
      const tree = [id];
      for (let i = 0; i < tree.length; i++)
        for (const child of owned.get(tree[i]!) ?? []) tree.push(child.id);
      const live = tree.some(
        (task) => owned.get(task)?.some((child) => child.status !== "terminal") === true,
      );
      if (!live && !tree.some(ownsConversation)) doomed.push(...tree);
    }

    raw.exec("BEGIN");
    try {
      for (const id of doomed) {
        const documents = "SELECT id FROM documents WHERE scope_kind = 'task' AND owner_id = ?";
        raw.run(`DELETE FROM document_revisions WHERE document_id IN (${documents})`, id);
        raw.run(`DELETE FROM record_ids WHERE id IN (${documents})`, id);
        raw.run("DELETE FROM documents WHERE scope_kind = 'task' AND owner_id = ?", id);
        raw.run("DELETE FROM tasks WHERE id = ?", id);
        raw.run("DELETE FROM record_ids WHERE id = ?", id);
      }
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
    return doomed.length;
  } finally {
    raw.close();
  }
}

function tasks(raw: RawDatabase, where: string, param: string | number): TaskRow[] {
  return raw.all(
    `SELECT id, status, json_extract(record, '$.owner') AS owner FROM tasks WHERE ${where}`,
    param,
  ) as TaskRow[];
}
