import type {
  ApprovalsResponse,
  AssistantsResponse,
  ErrorResponse,
  MeResponse,
  MemoryResponse,
  NudgesResponse,
  RoomResponse,
  TranscriptResponse,
} from "@nudge/server";

export type {
  ApprovalsResponse,
  AssistantsResponse,
  MeResponse,
  MemoryResponse,
  NudgesResponse,
  RoomResponse,
  TranscriptResponse,
};

// `Room`, `Fact` and `ScheduledNudge` aren't re-exported by name from `@nudge/server`: read them
// off a response type that already has one, same as `$assistant/index.tsx` does for `RoomKind`.
export type Room = RoomResponse["room"];
export type Fact = MemoryResponse["facts"][number];
export type ScheduledNudge = NudgesResponse["nudges"][number];
export type Approval = ApprovalsResponse["approvals"][number];

/** A non-2xx answer from the Nudge API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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

export function saveToken(assistant: string, token: string): void {
  sessionStorage.setItem(TOKENS, JSON.stringify({ ...readTokens(), [assistant]: token }));
}

export function forgetToken(assistant: string): void {
  const { [assistant]: _, ...rest } = readTokens();
  sessionStorage.setItem(TOKENS, JSON.stringify(rest));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ErrorResponse | undefined;
    throw new ApiError(response.status, body?.error ?? response.statusText);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** The assistants this server hosts; needs no token. */
export function listAssistants(): Promise<AssistantsResponse> {
  return request("/a");
}

/** Calls `/a/<assistant><path>` with the tab's token, or `token` when given. */
export function api<T>(
  assistant: string,
  path: string,
  init: RequestInit & { readonly token?: string } = {},
): Promise<T> {
  const { token = tokenFor(assistant), ...rest } = init;
  if (token === undefined) return Promise.reject(new ApiError(401, "Not signed in"));
  const headers = new Headers(rest.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (rest.body !== undefined) headers.set("content-type", "application/json");
  return request(`/a/${encodeURIComponent(assistant)}${path}`, { ...rest, headers });
}

/** A page of a room's transcript, newest first; `before` continues from a page's `next`. */
export function transcript(
  assistant: string,
  room: string,
  before?: string,
): Promise<TranscriptResponse> {
  const query = before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
  return api(assistant, `/rooms/${encodeURIComponent(room)}/transcript${query}`);
}

export function createSharedRoom(
  assistant: string,
  name: string,
  members: readonly string[] = [],
): Promise<Room> {
  return api(assistant, "/rooms", {
    method: "POST",
    body: JSON.stringify({ name, ...(members.length === 0 ? {} : { members }) }),
  });
}

/** Creates the caller's own room with this assistant, or returns it if it already exists. */
export function openPersonalRoom(assistant: string): Promise<Room> {
  return api(assistant, "/rooms/personal", { method: "POST" });
}

export function remember(assistant: string, room: string, text: string): Promise<Fact> {
  return api(assistant, `/rooms/${encodeURIComponent(room)}/memory`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function forget(assistant: string, room: string, id: string): Promise<void> {
  return api(assistant, `/rooms/${encodeURIComponent(room)}/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Approves or denies an approval; an approved action has run when this resolves. */
export function decideApproval(
  assistant: string,
  room: string,
  id: string,
  approve: boolean,
): Promise<Approval> {
  return api(assistant, `/rooms/${encodeURIComponent(room)}/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ approve }),
  });
}

export function cancelNudge(assistant: string, id: string): Promise<void> {
  return api(assistant, `/nudges/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Finds the assistant a token belongs to by asking each one who the token is, and keeps it.
 * Undefined when no assistant knows it.
 */
export async function signIn(token: string): Promise<MeResponse | undefined> {
  const { assistants } = await listAssistants();
  for (const { name } of assistants) {
    try {
      const me = await api<MeResponse>(name, "/me", { token });
      saveToken(name, token);
      return me;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
  }
  return undefined;
}
