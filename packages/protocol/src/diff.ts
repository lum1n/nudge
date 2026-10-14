import type { Op, Path } from "./schema.ts";

/**
 * The ops that turn `before` into `after`, for JSON values (keys holding `undefined` count as
 * absent). Parts that are the same object are skipped without a look inside, so a projector that
 * hands back unchanged items as the same objects keeps this cheap. A string that grew at its end
 * becomes an `append`; array items are matched by `id` where they have one, so a window that drops
 * its oldest item costs one splice rather than a rewrite.
 */
export function diff(before: unknown, after: unknown): Op[] {
  const ops: Op[] = [];
  walk(before, after, [], ops);
  return ops;
}

function walk(before: unknown, after: unknown, path: Path, ops: Op[]): void {
  if (before === after) return;
  if (typeof before === "string" && typeof after === "string") {
    if (before !== "" && after.startsWith(before))
      ops.push({ op: "append", path, text: after.slice(before.length) });
    else ops.push({ op: "set", path, value: after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) return walkArray(before, after, path, ops);
  if (isObject(before) && isObject(after) && sameKind(before, after))
    return walkObject(before, after, path, ops);
  if (!equal(before, after)) ops.push({ op: "set", path, value: after });
}

function walkObject(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: Path,
  ops: Op[],
): void {
  for (const key of Object.keys(before))
    if (before[key] !== undefined && after[key] === undefined)
      ops.push({ op: "del", path: [...path, key] });
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    if (before[key] === undefined) ops.push({ op: "set", path: [...path, key], value });
    else walk(before[key], value, [...path, key], ops);
  }
}

function walkArray(
  before: readonly unknown[],
  after: readonly unknown[],
  path: Path,
  ops: Op[],
): void {
  // A window that slid: the first item now was further in before.
  let old = before;
  const first = after.length > 0 ? keyOf(after[0]) : undefined;
  if (first !== undefined && keyOf(old[0]) !== first) {
    const at = old.findIndex((item) => keyOf(item) === first);
    if (at > 0) {
      ops.push({ op: "splice", path, index: 0, remove: at, insert: [] });
      old = old.slice(at);
    }
  }
  let index = 0;
  while (index < old.length && index < after.length && matches(old[index], after[index])) {
    walk(old[index], after[index], [...path, index], ops);
    index++;
  }
  if (index < old.length || index < after.length)
    ops.push({
      op: "splice",
      path,
      index,
      remove: old.length - index,
      insert: after.slice(index),
    });
}

/** Whether `after` is `before` changed in place, rather than another item. */
function matches(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  const key = keyOf(before);
  if (key !== undefined || keyOf(after) !== undefined) return key === keyOf(after);
  if (isObject(before) && isObject(after)) return sameKind(before, after);
  if (Array.isArray(before) && Array.isArray(after)) return true;
  return typeof before === typeof after;
}

function keyOf(item: unknown): string | number | undefined {
  if (!isObject(item)) return undefined;
  const id = item.id ?? item.callId;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** Objects of different `type`s are different things, even at the same place. */
function sameKind(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.type === b.type;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality of JSON values, keys holding `undefined` counting as absent. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const aKeys = keys(a);
  return aKeys.length === keys(b).length && aKeys.every((key) => equal(a[key], b[key]));
}
