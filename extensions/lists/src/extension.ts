import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import {
  defineNudgeExtension,
  defineTool,
  type ExtensionDocuments,
  keepsPlaceholders,
  readsOnly,
  roomOf,
  type RoomSocketHandler,
  section,
  Type,
} from "@nudge/core";
import {
  addItems,
  clearList,
  type Item,
  ListError,
  ListsDoc,
  listName,
  removeItems,
  setDone,
} from "./model.ts";

const VERSION = "0.1.0";

/** A list as the panel shows it. */
export type PanelList = { readonly name: string; readonly items: readonly Item[] };

/** What the panel socket sends. `ref` echoes the input's. */
export type PanelOutput =
  | { type: "lists"; lists: PanelList[] }
  | { type: "ok"; ref?: string }
  | { type: "error"; message: string; ref?: string };

/** What it takes. */
export type PanelInput = { ref?: string } & (
  | { type: "add"; list: string; text: string }
  | { type: "toggle"; list: string; id: string }
  | { type: "remove"; list: string; id: string }
  | { type: "clearDone"; list: string }
  | { type: "deleteList"; list: string }
);

/** Every open panel, per room, so a change from anywhere reaches them all. */
class Panels {
  private readonly viewers = new Map<string, Set<(data: string) => void>>();

  constructor(
    private readonly documents: () => ExtensionDocuments,
    /** Items people add are kept with placeholders, like the model's. */
    private readonly redact: (text: string) => string,
  ) {}

  async lists(roomId: string, context: Context = BACKGROUND_CONTEXT): Promise<PanelList[]> {
    const state = await this.documents().snapshot(ListsDoc, roomId, context);
    return Object.entries(state?.lists ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({ name, items: JSON.parse(JSON.stringify(list.items)) as Item[] }));
  }

  /** Sends the room's lists to its open panels. Never fails. */
  async changed(roomId: string): Promise<void> {
    const viewers = this.viewers.get(roomId);
    if (viewers === undefined || viewers.size === 0) return;
    try {
      const frame = JSON.stringify({
        type: "lists",
        lists: await this.lists(roomId),
      } satisfies PanelOutput);
      for (const send of viewers) send(frame);
    } catch {
      // The next change sends them again.
    }
  }

  readonly roomSocket: RoomSocketHandler = async ({ room, player }, socket) => {
    const send = (data: string) => socket.send(data);
    const reply = (output: PanelOutput) => socket.send(JSON.stringify(output));
    let viewers = this.viewers.get(room.id);
    if (viewers === undefined) this.viewers.set(room.id, (viewers = new Set()));
    viewers.add(send);
    reply({ type: "lists", lists: await this.lists(room.id) });
    let queue = Promise.resolve();
    return {
      receive: (data) => {
        queue = queue.then(async () => {
          let input: PanelInput;
          try {
            input = JSON.parse(data) as PanelInput;
          } catch {
            return reply({ type: "error", message: "Frames are JSON" });
          }
          const ref = typeof input.ref === "string" ? { ref: input.ref } : {};
          try {
            await this.apply(room.id, player.displayName, input);
            reply({ type: "ok", ...ref });
            await this.changed(room.id);
          } catch (error) {
            reply({ type: "error", message: (error as Error).message, ...ref });
          }
        });
      },
      close: () => {
        viewers.delete(send);
        if (viewers.size === 0) this.viewers.delete(room.id);
      },
    };
  };

  private async apply(roomId: string, by: string, input: PanelInput): Promise<void> {
    if (typeof input.list !== "string") throw new ListError("Say which list");
    const commit = <T>(change: Parameters<ExtensionDocuments["commit"]>[0]) =>
      this.documents().commit(change, BACKGROUND_CONTEXT) as Promise<T>;
    switch (input.type) {
      case "add":
        await commit((tx) =>
          addItems(tx, roomId, input.list, [this.redact(String(input.text ?? ""))], by, Date.now()),
        );
        return;
      case "toggle": {
        const item = (await this.lists(roomId))
          .find((list) => list.name === listName(input.list))
          ?.items.find((i) => i.id === input.id);
        if (item === undefined) throw new ListError("No such item");
        await commit((tx) => setDone(tx, roomId, input.list, [item.id], !item.done));
        return;
      }
      case "remove":
        await commit((tx) => removeItems(tx, roomId, input.list, [String(input.id)]));
        return;
      case "clearDone":
        await commit((tx) => clearList(tx, roomId, input.list, false));
        return;
      case "deleteList":
        await commit((tx) => clearList(tx, roomId, input.list, true));
        return;
      default:
        throw new ListError("Unknown input");
    }
  }
}

export const listsExtension = defineNudgeExtension({
  name: "lists",
  version: VERSION,
  description:
    "Shared lists per room, such as shopping and to-dos, for the model and in the web UI.",
  setup: (host) => {
    const panels = new Panels(host.documents, (text) => host.assistant().redact(text));
    const text = (value: string, isError = false) => ({
      output: [{ type: "text" as const, text: value }],
      ...(isError ? { isError } : {}),
    });
    const show = (name: string, items: readonly Item[]) =>
      `${name}:` +
      (items.length === 0
        ? " (empty)"
        : `\n${items.map((item) => `${item.id} [${item.done ? "x" : " "}] ${item.text}`).join("\n")}`);
    /** Runs a change in the tool's commit, tells the panels, and turns a refusal into tool text. */
    const change = async <T>(
      api: DocumentReader & { conversationId: number; commit: ExtensionDocuments["commit"] },
      context: Context,
      run: (roomId: string) => Parameters<ExtensionDocuments["commit"]>[0],
      say: (result: T, roomId: string) => string | Promise<string>,
    ) => {
      const room = await roomOf(api, api.conversationId, context);
      try {
        const result = (await api.commit(run(room.id), context)) as T;
        await panels.changed(room.id);
        return text(await say(result, room.id));
      } catch (error) {
        if (error instanceof ListError) return text(error.message, true);
        throw error;
      }
    };
    const listParameter = Type.String({ description: 'Like "shopping" or "todo".' });
    const refsParameter = Type.Array(Type.String(), {
      minItems: 1,
      description: "Item ids from list_show, or the items' text.",
    });

    const add = defineTool({
      name: "list_add",
      description:
        "Add items to one of this conversation's lists, making the list if it is new. An item " +
        "already on the list and not done isn't added twice.",
      parameters: Type.Object({
        list: listParameter,
        items: Type.Array(Type.String(), { minItems: 1 }),
      }),
      execute: (args, api, context) =>
        change<Item[]>(
          api,
          context,
          (roomId) => (tx) =>
            addItems(tx, roomId, args.list, args.items, host.displayName, host.now()),
          (added) =>
            added.length === 0
              ? `Nothing new for ${listName(args.list)}.`
              : `Added to ${listName(args.list)}: ${added.map((item) => `${item.id} ${item.text}`).join(", ")}.`,
        ),
    });

    const showTool = defineTool({
      name: "list_show",
      description: "Show one of this conversation's lists with its item ids, or every list.",
      parameters: Type.Object({ list: Type.Optional(listParameter) }),
      replay: "safe",
      execute: async (args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const lists = await panels.lists(room.id, context);
        if (args.list === undefined)
          return text(
            lists.length === 0
              ? "No lists yet."
              : lists.map((l) => show(l.name, l.items)).join("\n\n"),
          );
        const name = listName(args.list);
        const list = lists.find((l) => l.name === name);
        return list === undefined
          ? text(`No list "${name}".`, true)
          : text(show(list.name, list.items));
      },
    });

    const check = defineTool({
      name: "list_check",
      description: "Tick items off a list as done, or with done false put them back.",
      parameters: Type.Object({
        list: listParameter,
        items: refsParameter,
        done: Type.Optional(Type.Boolean()),
      }),
      execute: (args, api, context) =>
        change<{ changed: Item[]; unknown: string[] }>(
          api,
          context,
          (roomId) => (tx) => setDone(tx, roomId, args.list, args.items, args.done ?? true),
          ({ changed, unknown }) =>
            `${args.done === false ? "Put back" : "Ticked off"}: ${changed.map((i) => i.text).join(", ") || "nothing"}.` +
            (unknown.length === 0 ? "" : ` Not on the list: ${unknown.join(", ")}.`),
        ),
    });

    const remove = defineTool({
      name: "list_remove",
      description: "Remove items from a list altogether.",
      parameters: Type.Object({ list: listParameter, items: refsParameter }),
      execute: (args, api, context) =>
        change<{ removed: Item[]; unknown: string[] }>(
          api,
          context,
          (roomId) => (tx) => removeItems(tx, roomId, args.list, args.items),
          ({ removed, unknown }) =>
            `Removed: ${removed.map((i) => i.text).join(", ") || "nothing"}.` +
            (unknown.length === 0 ? "" : ` Not on the list: ${unknown.join(", ")}.`),
        ),
    });

    const clear = defineTool({
      name: "list_clear",
      description: "Drop a list's done items, or with all true the whole list.",
      parameters: Type.Object({ list: listParameter, all: Type.Optional(Type.Boolean()) }),
      execute: (args, api, context) =>
        change<number>(
          api,
          context,
          (roomId) => (tx) => clearList(tx, roomId, args.list, args.all ?? false),
          (count) =>
            args.all
              ? `Deleted ${listName(args.list)} (${count} items).`
              : `Cleared ${count} done items.`,
        ),
    });

    return {
      // Lists keep what they are given; values go back in only where someone sees them.
      tools: [add, readsOnly(showTool), check, remove, clear].map((tool) =>
        keepsPlaceholders(tool),
      ),
      roomSocket: panels.roomSocket,
      sections: [
        section("lists", async (input, context) => {
          const room = await roomOf(input.read, input.conversationId, context).catch(
            () => undefined,
          );
          if (room === undefined) return undefined;
          const state = await input.read.snapshot(ListsDoc, room.id, context);
          const lists = Object.entries(state?.lists ?? {});
          if (lists.length === 0)
            return "This conversation can keep shared lists (list_add, list_show, list_check, list_remove, list_clear), such as shopping or to-dos.";
          return (
            "Lists of this conversation, which people also see and change in the web UI: " +
            lists
              .map(([name, list]) => `${name} (${list.items.filter((i) => !i.done).length} open)`)
              .join(", ") +
            ". Read one with list_show before answering about it."
          );
        }),
      ],
    };
  },
});

export default listsExtension;
