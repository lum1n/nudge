import { defineDocFamily, type Tx } from "@earendil-works/pi-durable";

/** A header or variable a person gives the value of on the room's MCP panel, never the model. */
export type ServerKey = {
  readonly in: "header" | "env";
  readonly name: string;
  /** Goes before the value, such as `"Bearer "`. */
  readonly prefix?: string;
};

// Stored in a document, so plain JSON.
export type RoomServer = {
  /** `m<n>` within the room. */
  id: string;
  /** Lower-case letters, digits, - and _; unique within the room. */
  name: string;
  /** What to use it for, in a sentence; shown to the model. */
  useFor: string;
  /** A Streamable HTTP server, or else a program to start. */
  url?: string;
  command?: string;
  args?: string[];
  /** Sent on every request, or given to the program; never secret (keys are in the secrets store). */
  headers?: Record<string, string>;
  env?: Record<string, string>;
  keys: ServerKey[];
  /** Which calls wait for approval, as for configured servers. People change it, never the model. */
  approval: "writes" | "always" | "never";
  addedBy: string;
  addedAt: number;
};

export type RoomServersState = {
  servers: RoomServer[];
  next: number;
};

/** The MCP servers people added to a room, keyed by room id. */
export const RoomServersDoc = defineDocFamily<RoomServersState, null>({
  kind: "nudge.mcp.servers",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ servers: [], next: 1 }),
});

export const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type ServerDraft = Pick<
  RoomServer,
  "name" | "useFor" | "url" | "command" | "args" | "headers" | "env"
> & { keys?: ServerKey[] };

/** Throws, saying why, when a draft isn't a server that can be added. */
export function checkDraft(draft: ServerDraft): void {
  if (!SERVER_NAME.test(draft.name))
    throw new Error(`"${draft.name}" is not lower-case letters, digits, - and _ (at most 32)`);
  if ((draft.url === undefined) === (draft.command === undefined))
    throw new Error("Give either a url or a command");
  if (draft.url !== undefined) {
    let url: URL;
    try {
      url = new URL(draft.url);
    } catch {
      throw new Error(`"${draft.url}" is not a URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("The URL must be http or https");
    if (url.username !== "" || url.password !== "")
      throw new Error("Leave passwords out of the URL; add a key instead");
  }
  for (const key of draft.keys ?? []) {
    if (key.in === "env" && draft.command === undefined)
      throw new Error(`${key.name} is a variable, but a remote server takes headers`);
    if (key.in === "header" && draft.url === undefined)
      throw new Error(`${key.name} is a header, but a program takes variables`);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key.name)) throw new Error(`Bad key name "${key.name}"`);
  }
}

export async function addServer(
  tx: Tx,
  roomId: string,
  draft: ServerDraft,
  addedBy: string,
  now: number,
): Promise<RoomServer> {
  checkDraft(draft);
  const state = await tx.doc(RoomServersDoc, roomId, null);
  if (state.servers.some((server) => server.name === draft.name))
    throw new Error(`This room has an MCP server "${draft.name}" already`);
  const server: RoomServer = {
    id: `m${state.next}`,
    name: draft.name,
    useFor: draft.useFor,
    ...(draft.url === undefined ? {} : { url: draft.url }),
    ...(draft.command === undefined ? {} : { command: draft.command }),
    ...(draft.args === undefined ? {} : { args: [...draft.args] }),
    ...(draft.headers === undefined ? {} : { headers: { ...draft.headers } }),
    ...(draft.env === undefined ? {} : { env: { ...draft.env } }),
    keys: (draft.keys ?? []).map((key) => ({ ...key })),
    approval: "writes",
    addedBy,
    addedAt: now,
  };
  state.next += 1;
  state.servers.push(server);
  return copy(server);
}

export async function updateServer(
  tx: Tx,
  roomId: string,
  id: string,
  change: Partial<Pick<RoomServer, "useFor" | "approval">>,
): Promise<RoomServer> {
  const state = await tx.doc(RoomServersDoc, roomId, null);
  const server = state.servers.find((s) => s.id === id || s.name === id);
  if (server === undefined) throw new Error(`No MCP server "${id}" in this room`);
  if (change.useFor !== undefined) server.useFor = change.useFor;
  if (change.approval !== undefined) server.approval = change.approval;
  return copy(server);
}

/** The server removed, or undefined when the room has none by that id or name. */
export async function removeServer(
  tx: Tx,
  roomId: string,
  id: string,
): Promise<RoomServer | undefined> {
  const state = await tx.doc(RoomServersDoc, roomId, null);
  const index = state.servers.findIndex((s) => s.id === id || s.name === id);
  if (index === -1) return undefined;
  const [removed] = state.servers.splice(index, 1);
  return copy(removed!);
}

/** What the server runs or reaches, for an approval or the panel. */
export function describeServer(server: Pick<RoomServer, "url" | "command" | "args">): string {
  if (server.url !== undefined) return server.url;
  return [server.command!, ...(server.args ?? [])].map(quote).join(" ");
}

/** A plain copy of a document's value, which is a proxy `structuredClone` can't copy. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
