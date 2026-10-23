import {
  Api,
  ApiError,
  checkSetupCode,
  checkSetupKey,
  type KeyValueStorage,
  type RoomListStore,
  listAssistants,
  NudgeClient,
  outboxKey,
  ServerApi,
  setUp,
  type SetupRequest,
  setupInfo,
  signInStatus,
  type SignInResponse,
  startSignIn,
  type RoomState,
  type RoomStore,
  type TokenStore,
} from "@nudge/client";
import { useEffect, useState, useSyncExternalStore } from "react";

export { ApiError, checkSetupCode, checkSetupKey, listAssistants, setupInfo, type SignInResponse };

// One token per assistant, keyed by the assistant's URL name. They live for the browser tab only
// (sessionStorage), unless "Remember this device" was ticked at sign-in (localStorage), so that a
// notification opened after the tab closed doesn't ask to sign in again.
const TOKENS = "nudge.tokens";

function readFrom(storage: Storage): Record<string, string> {
  try {
    return JSON.parse(storage.getItem(TOKENS) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function readTokens(): Record<string, string> {
  return { ...readFrom(localStorage), ...readFrom(sessionStorage) };
}

function writeTo(storage: Storage, assistant: string, token: string | undefined): void {
  const { [assistant]: _, ...rest } = readFrom(storage);
  storage.setItem(
    TOKENS,
    JSON.stringify(token === undefined ? rest : { ...rest, [assistant]: token }),
  );
}

export function tokenFor(assistant: string): string | undefined {
  return readTokens()[assistant];
}

/** Assistants this tab has a token for. */
export function signedIn(): string[] {
  return Object.keys(readTokens());
}

/** Keeps the token in one storage only: the device's when remembered, else the tab's. */
function saveToken(assistant: string, token: string, remember: boolean): void {
  writeTo(remember ? localStorage : sessionStorage, assistant, token);
  writeTo(remember ? sessionStorage : localStorage, assistant, undefined);
}

/**
 * Forgets the assistant's token, in the tab and on the device, and its unsent messages, and closes
 * its client. The client stays, so pages still mounted don't make a new one (which, without a
 * token, would close with 4401 and sign out again).
 */
export function forgetToken(assistant: string): void {
  writeTo(sessionStorage, assistant, undefined);
  writeTo(localStorage, assistant, undefined);
  outboxStorage(assistant).removeItem(outboxKey("", assistant));
  clients.get(assistant)?.close();
}

/** Keeps a token, and connects the assistant's client with it. */
function signedInWith(assistant: string, token: string, remember: boolean): void {
  saveToken(assistant, token, remember);
  clients.get(assistant)?.open();
}

/** Whether the assistant's current token is kept on the device rather than in the tab. */
function remembered(assistant: string): boolean {
  return readFrom(localStorage)[assistant] !== undefined;
}

/** A new token is kept where the old one was, unless `remember` says where. */
function tokenStore(assistant: string, remember?: boolean): TokenStore {
  return {
    get: () => tokenFor(assistant),
    set: (token) =>
      token === undefined
        ? forgetToken(assistant)
        : signedInWith(assistant, token, remember ?? remembered(assistant)),
  };
}

/**
 * Where an assistant's unsent messages are kept, so a reload doesn't lose them: with its token, on
 * the device when remembered, else in the tab.
 */
function outboxStorage(assistant: string): KeyValueStorage {
  const where = () => (remembered(assistant) ? localStorage : sessionStorage);
  return {
    getItem: (key) => where().getItem(key),
    setItem: (key, value) => where().setItem(key, value),
    removeItem: (key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    },
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
      storage: outboxStorage(assistant),
    });
    clients.set(assistant, client);
    client.open();
  }
  return client;
}

// Back online, or back on the page: reconnect now rather than when the backoff runs out, and send
// what waits in the outboxes, as the Android app does when it comes to the foreground.
function retryAll(): void {
  for (const client of clients.values()) client.retryNow();
}
if (typeof document !== "undefined") {
  addEventListener("online", retryAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryAll();
  });
}

/** The connection's status, re-rendering on every change. */
export function useConnection(assistant: string) {
  const { connection } = clientFor(assistant);
  return useSyncExternalStore(connection.subscribe, connection.getStatus);
}

/** Holds the player's room list while mounted; undefined until the lease is taken. */
export function useRoomList(assistant: string): RoomListState | undefined {
  return useStoreState(useLease(assistant, "rooms", (client) => client.roomList()));
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

type RoomListState = ReturnType<RoomListStore["getState"]>;

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
 * Finds the assistant a token belongs to by asking each one who the token is, and keeps it, on
 * the device with `remember`. Undefined when no assistant knows it.
 */
export async function signIn(token: string, remember: boolean): Promise<string | undefined> {
  return firstAssistant(async (assistant) => {
    await new Api({ server: "", assistant, tokens: fixedToken(token) }).me();
    signedInWith(assistant, token, remember);
  });
}

/** Trades a pairing code from `nudge pair` for a token of whichever assistant made it. */
export async function pair(code: string, remember: boolean): Promise<string | undefined> {
  return firstAssistant(async (assistant) => {
    await new Api({ server: "", assistant, tokens: tokenStore(assistant, remember) }).pair(code, {
      name: CLIENT.name,
      platform: CLIENT.platform,
    });
  });
}

/** A QR code for the Nudge app to sign this browser in with. */
export function startQrSignIn(): Promise<SignInResponse> {
  return startSignIn("");
}

/**
 * Once the app approved `started`, pairs with the code it left and names the assistant; undefined
 * while it waits. A 404 once the QR code expired.
 */
export async function finishQrSignIn(
  started: SignInResponse,
  remember: boolean,
): Promise<string | undefined> {
  const status = await signInStatus("", started);
  if (status.status === "waiting") return undefined;
  const { assistant, code } = status;
  await new Api({ server: "", assistant, tokens: tokenStore(assistant, remember) }).pair(code, {
    name: CLIENT.name,
    platform: CLIENT.platform,
  });
  return assistant;
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

// The owner's server token (ADR 11), kept on the device: whoever set the server up here owns it.
const SERVER_TOKEN = "nudge.server";

/** The server's own API, signed in as an owner when this device has their server token. */
export function serverApi(): ServerApi {
  return new ServerApi({
    server: "",
    tokens: {
      get: () => localStorage.getItem(SERVER_TOKEN) ?? undefined,
      set: (token) =>
        token === undefined
          ? localStorage.removeItem(SERVER_TOKEN)
          : localStorage.setItem(SERVER_TOKEN, token),
    },
  });
}

/**
 * Sets the server up from the wizard, and signs this device in: to the new assistant as its first
 * player, remembered, and to the server as its owner. Returns the assistant's name and player id.
 */
export async function setUpServer(
  choices: Omit<SetupRequest, "client">,
): Promise<{ assistant: string; playerId: string }> {
  const done = await setUp("", {
    ...choices,
    client: { name: CLIENT.name, platform: CLIENT.platform },
  });
  signedInWith(done.assistant, done.token, true);
  localStorage.setItem(SERVER_TOKEN, done.serverToken);
  return { assistant: done.assistant, playerId: done.player.id };
}
