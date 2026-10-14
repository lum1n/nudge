import type { Op, Path } from "./schema.ts";

/**
 * `view` with `ops` applied in order. `view` itself is left alone: every object and array on a
 * changed path is a new one, and everything else is shared, so a part that is the same object as
 * before did not change. Throws when an op doesn't fit the view; a client then subscribes again.
 */
export function apply<T>(view: T, ops: readonly Op[]): T {
  // Containers this call made, which later ops may change in place.
  const fresh = new WeakSet<object>();
  let root: unknown = view;
  for (const op of ops) {
    if (op.path.length === 0) {
      if (op.op !== "set") throw new Error(`Cannot ${op.op} the whole view`);
      root = op.value;
      continue;
    }
    root = copy(root, fresh);
    let parent = root as Container;
    for (const key of op.path.slice(0, -1)) {
      const child = copy(read(parent, key), fresh);
      write(parent, key, child);
      parent = child;
    }
    const last = op.path.at(-1)!;
    switch (op.op) {
      case "set":
        write(parent, last, op.value);
        break;
      case "del":
        if (Array.isArray(parent)) throw new Error(`Cannot del an array item at ${show(op.path)}`);
        delete parent[last];
        break;
      case "append": {
        const text = read(parent, last);
        if (typeof text !== "string") throw new Error(`No string to append to at ${show(op.path)}`);
        write(parent, last, text + op.text);
        break;
      }
      case "splice": {
        const array = copy(read(parent, last), fresh);
        if (!Array.isArray(array) || op.index > array.length)
          throw new Error(`No array to splice at ${show(op.path)}`);
        array.splice(op.index, op.remove, ...op.insert);
        write(parent, last, array);
        break;
      }
    }
  }
  return root as T;
}

type Container = Record<string | number, unknown> | unknown[];

function copy(value: unknown, fresh: WeakSet<object>): Container {
  if (typeof value !== "object" || value === null) throw new Error("No object or array there");
  if (fresh.has(value)) return value as Container;
  const made: Container = Array.isArray(value) ? [...value] : { ...value };
  fresh.add(made);
  return made;
}

function read(parent: Container, key: string | number): unknown {
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || key >= parent.length) throw new Error(`No item ${key}`);
    return parent[key];
  }
  return parent[key];
}

function write(parent: Container, key: string | number, value: unknown): void {
  if (Array.isArray(parent) && (typeof key !== "number" || key >= parent.length))
    throw new Error(`No item ${key}`);
  (parent as Record<string | number, unknown>)[key] = value;
}

function show(path: Path): string {
  return path.join("/");
}
