import { type PanelSocket, type PanelSocketState, usePanelSocket } from "./panel-socket.ts";

/** An item as the panel shows it (`Item` in `@nudge/ext-lists`). */
export type ListItem = { id: string; text: string; done: boolean; by: string; at: number };
export type PanelList = { name: string; items: ListItem[] };

export type ListsInput =
  | { type: "add"; list: string; text: string }
  | { type: "toggle"; list: string; id: string }
  | { type: "remove"; list: string; id: string }
  | { type: "clearDone"; list: string }
  | { type: "deleteList"; list: string };

type ListsFrame = { type: "lists"; lists: PanelList[] };

export type ListsSocket = PanelSocket<PanelList[], ListsInput, ListsFrame>;

/** One room's lists, kept current by the server. */
export function useLists(
  assistant: string,
  room: string,
): [ListsSocket | undefined, PanelSocketState<PanelList[]>] {
  return usePanelSocket<PanelList[], ListsInput, ListsFrame>(assistant, room, "lists", (frame) =>
    frame.type === "lists" ? frame.lists : undefined,
  );
}
