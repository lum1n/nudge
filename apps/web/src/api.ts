import {
  Api,
  ApiError,
  type HomeStore,
  listAssistants,
  NudgeClient,
  type RoomState,
  type RoomStore,
  type TokenStore,
} from "@nudge/client";
import { useEffect, useState, useSyncExternalStore } from "react";

export { ApiError, listAssistants };

// Tokens live for the browser tab only: one per assistant, keyed by the assistant's URL name.
const TOKENS = "nudge.tokens";

function readTokens(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(TOKENS) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function tokenFor(assistant: string): string | undefined {
  return readTokens()[assistant];
}

/** Assistants this tab has a token for. */
export function signedIn(): string[] {
  return Object.keys(readTokens());
}

function saveToken(assistant: string, token: string): void {
  sessionStorage.setItem(TOKENS, JSON.stringify({ ...readTokens(), [assistant]: token }));
}

/**
 * Forgets the assistant's token and closes its client. The client stays, so pages still mounted
 * don't make a new one (which, without a token, would close with 4401 and sign out again).
 */
export function forgetToken(assistant: string): void {
  const { [assistant]: _, ...rest } = readTokens();
  sessionStorage.setItem(TOKENS, JSON.stringify(rest));
  clients.get(assistant)?.close();
}

/** Keeps a token, and connects the assistant's client with it. */
function signedInWith(assistant: string, token: string): void {
  saveToken(assistant, token);
  clients.get(assistant)?.open();
}

function tokenStore(assistant: string): TokenStore {
  return {
    get: () => tokenFor(assistant),
    set: (token) => (token === undefined ? forgetToken(assistant) : signedInWith(assistant, token)),
  };
}

const CLIENT = { name: "nudge-web", version: "0.0.0", platform: "web" } as const;

const clients = new Map<string, NudgeClient>();

/** The tab's client of `assistant`, its socket opened on first use; `""` is the page's origin. */
export function clientFor(assistant: string): NudgeClient {
  let client = clients.get(assistant);
  if (client === undefined) {
    client = new NudgeClient({
      server: "",
      assistant,
      tokens: tokenStore(assistant),
      client: CLIENT,
    });
    clients.set(assistant, client);
    client.open();
  }
  return client;
}

/** The connection's status, re-rendering on every change. */
export function useConnection(assistant: string) {
  const { connection } = clientFor(assistant);
  return useSyncExternalStore(connection.subscribe, connection.getStatus);
}

/** Holds the player's home view while mounted; undefined until the lease is taken. */
export function useHome(assistant: string): HomeState | undefined {
  return useStoreState(useLease(assistant, "home", (client) => client.home()));
}

/** Holds a room's view while mounted; undefined until the lease is taken. */
export function useRoom(
  assistant: string,
  room: string,
): { store: RoomStore; state: RoomState } | undefined {
  const store = useLease(assistant, `room:${room}`, (client) => client.room(room));
  const state = useStoreState(store);
  return store === undefined || state === undefined ? undefined : { store, state };
}

type HomeState = ReturnType<HomeStore["getState"]>;

function useLease<S>(
  assistant: string,
  target: string,
  take: (client: NudgeClient) => { store: S; release(): void },
): S | undefined {
  const [store, setStore] = useState<S>();
  useEffect(() => {
    const lease = take(clientFor(assistant));
    setStore(lease.store);
    return () => {
      lease.release();
      setStore(undefined);
    };
  }, [assistant, target]);
  return store;
}

const noStore = { subscribe: () => () => {}, getState: () => undefined };

function useStoreState<T>(
  store: { subscribe(listener: () => void): () => void; getState(): T } | undefined,
): T | undefined {
  const { subscribe, getState } = store ?? noStore;
  return useSyncExternalStore(subscribe, getState);
}

/**
 * Finds the assistant a token belongs to by asking each one who the token is, and keeps it.
 * Undefined when no assistant knows it.
 */
export async function signIn(token: string): Promise<string | undefined> {
  return firstAssistant(async (assistant) => {
    await new Api({ server: "", assistant, tokens: fixedToken(token) }).me();
    signedInWith(assistant, token);
  });
}

/** Trades a pairing code from `nudge pair` for a token of whichever assistant made it. */
export async function pair(code: string): Promise<string | undefined> {
  return firstAssistant(async (assistant) => {
    await new Api({ server: "", assistant, tokens: tokenStore(assistant) }).pair(code, {
      name: CLIENT.name,
      platform: CLIENT.platform,
    });
  });
}

/** Runs `attempt` for each assistant until one doesn't answer 401, and names that one. */
async function firstAssistant(
  attempt: (assistant: string) => Promise<void>,
): Promise<string | undefined> {
  const { assistants } = await listAssistants("");
  for (const { name } of assistants) {
    try {
      await attempt(name);
      return name;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
  }
  return undefined;
}

function fixedToken(token: string): TokenStore {
  return { get: () => token, set: () => {} };
}
