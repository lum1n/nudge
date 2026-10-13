import type {
  AssistantsResponse,
  ErrorResponse,
  MeResponse,
  RoomResponse,
  TranscriptResponse,
} from "@nudge/server";

export type { AssistantsResponse, MeResponse, RoomResponse, TranscriptResponse };

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
