import { defineDocFamily, type SessionDocFamilyToken, type Tx } from "@nudge/core";

// Stored in a document, so plain JSON.
export type Item = {
  /** `i1`, `i2`, … within the room. */
  id: string;
  text: string;
  done: boolean;
  /** Who added it: a player's name, or the assistant's. */
  by: string;
  at: number;
};

export type ListsState = {
  /** By name, lower case. */
  lists: Record<string, { items: Item[] }>;
  next: number;
};

/** A room's lists, keyed by room id. */
export const ListsDoc: SessionDocFamilyToken<ListsState, null> = defineDocFamily({
  kind: "lists.room",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ lists: {}, next: 1 }),
});

export const MAX_LISTS = 20;
export const MAX_ITEMS = 200;

export class ListError extends Error {
  override name = "ListError";
}

/** `"  Shopping "` → `"shopping"`. */
export function listName(name: string): string {
  const normal = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (normal === "") throw new ListError("A list needs a name");
  if (normal.length > 40) throw new ListError("List names are at most 40 characters");
  return normal;
}

export async function addItems(
  tx: Tx,
  roomId: string,
  name: string,
  texts: readonly string[],
  by: string,
  now: number,
): Promise<Item[]> {
  const list = listName(name);
  const state = await tx.doc(ListsDoc, roomId, null);
  if (state.lists[list] === undefined && Object.keys(state.lists).length >= MAX_LISTS)
    throw new ListError(`This conversation has ${MAX_LISTS} lists already`);
  state.lists[list] ??= { items: [] };
  const items = state.lists[list].items;
  const added: Item[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (text === "") continue;
    if (items.length >= MAX_ITEMS) throw new ListError(`"${list}" has ${MAX_ITEMS} items already`);
    // Something already there and not done isn't added twice.
    if (items.some((item) => !item.done && item.text.toLowerCase() === text.toLowerCase()))
      continue;
    const item: Item = { id: `i${state.next}`, text, done: false, by, at: now };
    state.next += 1;
    items.push({ ...item });
    added.push(item);
  }
  return added;
}

/**
 * Marks items done or not done. `refs` are ids or texts (case doesn't matter); returns the items
 * changed, and the refs that matched nothing.
 */
export async function setDone(
  tx: Tx,
  roomId: string,
  name: string,
  refs: readonly string[],
  done: boolean,
): Promise<{ changed: Item[]; unknown: string[] }> {
  const items = await existing(tx, roomId, name);
  const changed: Item[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const item = find(items, ref);
    if (item === undefined) unknown.push(ref);
    else {
      item.done = done;
      changed.push({ ...item });
    }
  }
  return { changed, unknown };
}

export async function removeItems(
  tx: Tx,
  roomId: string,
  name: string,
  refs: readonly string[],
): Promise<{ removed: Item[]; unknown: string[] }> {
  const list = listName(name);
  const state = await tx.doc(ListsDoc, roomId, null);
  const items = state.lists[list]?.items;
  if (items === undefined) throw new ListError(`No list "${list}"`);
  const removed: Item[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const item = find(items, ref);
    if (item === undefined) unknown.push(ref);
    else removed.push({ ...item });
  }
  const gone = new Set(removed.map((item) => item.id));
  state.lists[list] = {
    items: items.filter((item) => !gone.has(item.id)).map((item) => ({ ...item })),
  };
  return { removed, unknown };
}

/** Drops the done items, or with `all` the whole list; returns how many items went. */
export async function clearList(
  tx: Tx,
  roomId: string,
  name: string,
  all: boolean,
): Promise<number> {
  const list = listName(name);
  const state = await tx.doc(ListsDoc, roomId, null);
  const items = state.lists[list]?.items;
  if (items === undefined) throw new ListError(`No list "${list}"`);
  if (all) {
    delete state.lists[list];
    return items.length;
  }
  const kept = items.filter((item) => !item.done).map((item) => ({ ...item }));
  state.lists[list] = { items: kept };
  return items.length - kept.length;
}

async function existing(tx: Tx, roomId: string, name: string): Promise<Item[]> {
  const list = listName(name);
  const items = (await tx.doc(ListsDoc, roomId, null)).lists[list]?.items;
  if (items === undefined) throw new ListError(`No list "${list}"`);
  return items;
}

function find(items: Item[], ref: string): Item | undefined {
  const key = ref.trim().toLowerCase();
  return (
    items.find((item) => item.id === key) ??
    items.find((item) => !item.done && item.text.toLowerCase() === key) ??
    items.find((item) => item.text.toLowerCase() === key)
  );
}
