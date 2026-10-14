import type { Context } from "@earendil-works/chord";
import {
  type DocumentReader,
  defineDoc,
  defineDocFamily,
  type Tx,
} from "@earendil-works/pi-durable";

/** Where a connector's secret (its API key) goes on the wire, once a person has set one. */
export type ConnectorAuth = {
  readonly in: "header" | "query";
  readonly name: string;
  /** Goes before the secret value, e.g. `"Bearer "`. */
  readonly prefix?: string;
};

// Stored in a document, so plain JSON.
export type Connector = {
  /** `c<n>` for a room's own, `s<n>` for one shared with every room; always distinct across both. */
  id: string;
  name: string;
  baseUrl: string;
  /** What to use it for; shown to the model and used to prefer it over browsing. */
  useFor: string;
  docsUrl?: string;
  /** Sent on every call; never secret (those live in the extension's `secrets` store). */
  headers: Record<string, string>;
  auth?: ConnectorAuth;
  /** What the model has learned about using it; grows over time via `update_connector`. */
  notes: string;
  /** Lets it reach localhost and the local network. A human sets this, never the model. */
  allowPrivateNetwork: boolean;
  /** `"METHOD /path"` entries that run without approval even though they aren't GET or HEAD. */
  readPaths: string[];
  addedBy: string;
  addedAt: number;
};

export type ConnectorsState = {
  connectors: Connector[];
  next: number;
};

/** A room's own connectors, keyed by room id. */
export const ConnectorsDoc = defineDocFamily<ConnectorsState, null>({
  kind: "nudge.connectors.room",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ connectors: [], next: 1 }),
});

/** Connectors shared with every room. Owner-only to change (CLI); every room may read and call them. */
export const SharedConnectorsDoc = defineDoc<ConnectorsState>({
  kind: "nudge.connectors.shared",
  version: 1,
  scope: "session",
  initial: () => ({ connectors: [], next: 1 }),
});

export const MAX_CONNECTORS = 30;

export class ConnectorNotFound extends Error {
  override name = "ConnectorNotFound";
}

export type ConnectorDraft = {
  readonly name: string;
  readonly baseUrl: string;
  readonly useFor: string;
  readonly docsUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: ConnectorAuth;
};

/** Adds a connector to a room's own list, inside a commit. */
export async function addConnector(
  tx: Tx,
  roomId: string,
  draft: ConnectorDraft,
  addedBy: string,
  now: number,
): Promise<Connector> {
  const state = await tx.doc(ConnectorsDoc, roomId, null);
  if (state.connectors.length >= MAX_CONNECTORS)
    throw new Error(`This conversation has ${MAX_CONNECTORS} connectors already; remove one first`);
  const connector = makeConnector(`c${state.next}`, draft, addedBy, now);
  state.next += 1;
  state.connectors.push(copy(connector));
  return connector;
}

/** Changes a room's own connector's `useFor`, `notes`, `docsUrl`, `baseUrl` or `readPaths`. */
export async function updateConnector(
  tx: Tx,
  roomId: string,
  id: string,
  patch: Partial<
    Pick<
      Connector,
      | "useFor"
      | "notes"
      | "docsUrl"
      | "baseUrl"
      | "readPaths"
      | "auth"
      | "headers"
      | "allowPrivateNetwork"
    >
  >,
): Promise<Connector> {
  const state = await tx.doc(ConnectorsDoc, roomId, null);
  const connector = state.connectors.find((c: Connector) => c.id === id);
  if (connector === undefined) throw new ConnectorNotFound(`No connector "${id}" in this room`);
  Object.assign(connector, patch);
  return copy(connector);
}

/** False when the room had no connector with that id. */
export async function removeConnector(tx: Tx, roomId: string, id: string): Promise<boolean> {
  const state = await tx.doc(ConnectorsDoc, roomId, null);
  const index = state.connectors.findIndex((c: Connector) => c.id === id);
  if (index < 0) return false;
  state.connectors.splice(index, 1);
  return true;
}

/** A room's own connectors plus every one shared with all rooms. */
export async function visibleConnectors(
  read: DocumentReader,
  roomId: string,
  context: Context,
): Promise<Connector[]> {
  const [own, shared] = await Promise.all([
    read.snapshot(ConnectorsDoc, roomId, context),
    read.snapshot(SharedConnectorsDoc, context),
  ]);
  return [...(own?.connectors ?? []), ...(shared?.connectors ?? [])].map((c: Connector) => copy(c));
}

function makeConnector(id: string, draft: ConnectorDraft, addedBy: string, now: number): Connector {
  const name = draft.name.trim();
  if (name === "") throw new Error("A connector needs a name");
  const baseUrl = normalizeBaseUrl(draft.baseUrl);
  const useFor = draft.useFor.trim();
  if (useFor === "") throw new Error("Say what the connector is for");
  return {
    id,
    name,
    baseUrl,
    useFor,
    ...(draft.docsUrl === undefined ? {} : { docsUrl: draft.docsUrl }),
    headers: { ...draft.headers },
    ...(draft.auth === undefined ? {} : { auth: draft.auth }),
    notes: "",
    allowPrivateNetwork: false,
    readPaths: [],
    addedBy,
    addedAt: now,
  };
}

/** Checks `baseUrl` parses as http(s) and has no query or fragment, to keep path joining predictable. */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`"${value}" must be http or https`);
  if (url.search || url.hash) throw new Error("A connector's base URL has no query or fragment");
  return url.toString();
}

/** A plain copy of a stored connector; documents hand out proxies. */
function copy(connector: Readonly<Connector>): Connector {
  return JSON.parse(JSON.stringify(connector)) as Connector;
}
