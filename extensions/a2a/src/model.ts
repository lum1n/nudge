import { defineDoc, type JsonObject } from "@nudge/core";

type JsonValue = JsonObject[string];

/** The player something private belongs to, with the name others are told it went to. */
export type Owner = { playerId: string; displayName: string };

// Stored in a document, so plain JSON. Tasks and cards are kept as A2A's JSON (ProtoJSON).

/** An outside agent that may call this assistant, with a token an admin handed it. */
export type Client = {
  /** `c1`, `c2`, … on this assistant. */
  id: string;
  name: string;
  /** SHA-256 of its token, hex; the token itself is shown once and kept nowhere. */
  tokenHash: string;
  /** The player it speaks as here, and the room it speaks in. */
  playerId: string;
  roomId: string;
  /** Messages it sent this hour, for `maxMessagesPerHour`. */
  sent: { hourStart: number; count: number };
  createdAt: number;
};

/** Where to tell a client its task changed. */
export type PushConfig = {
  id: string;
  url: string;
  /** Sent back as `X-A2A-Notification-Token`, so it knows the call is ours. */
  token?: string;
  authentication?: { scheme: string; credentials: string };
};

/** A task a client gave this assistant: one message, answered in its room. */
export type ServedTask = {
  id: string;
  clientId: string;
  /** The message it came with, so a retry finds this task. */
  messageId: string;
  /** A2A `Task` JSON: id, contextId, status, artifacts, history. */
  task: TaskJson;
  /** Its turn ended with an approval pending: the answer after it finishes the task. */
  waiting?: true;
  push: PushConfig[];
  createdAt: number;
};

/** An outside agent this assistant may call, added by an admin. */
export type Agent = {
  /** `g1`, `g2`, … on this assistant. */
  id: string;
  name: string;
  description: string;
  /** Where its card was read. */
  url: string;
  /** Its Agent Card, A2A JSON, as read when it was added. */
  card: JsonObject;
  /** Whether a bearer token is kept for it in the extension's secrets. */
  hasToken: boolean;
  createdAt: number;
};

/** A message this assistant sent an agent whose answer took longer than a turn. */
export type Call = {
  id: string;
  agentId: string;
  contextId: string;
  taskId: string;
  /** Its A2A task state when last seen, such as `TASK_STATE_WORKING`. */
  state: string;
  roomId: string;
  /** What was asked, cut short, for the room to be reminded of. */
  asked: string;
  privateTo?: Owner;
  /** The token the agent sends with push notifications about it. */
  pushToken: string;
  status: "open" | "done";
  deadline: number;
  /** The durable task that checks on it, as a string. */
  timerId?: string;
  createdAt: number;
};

/** The latest task in a conversation with an agent, so a reply to its question continues it. */
export type Conversation = {
  agentId: string;
  taskId?: string;
  state: string;
  roomId: string;
  updatedAt: number;
};

export type TaskJson = {
  id: string;
  contextId: string;
  status: { state: string; message?: MessageJson; timestamp?: string };
  artifacts?: { artifactId: string; name?: string; parts: PartJson[] }[];
  history?: MessageJson[];
  metadata?: JsonObject;
};

export type MessageJson = {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: string;
  parts: PartJson[];
  metadata?: JsonObject;
};

export type PartJson = {
  text?: string;
  data?: JsonValue;
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
};

export type A2AState = {
  clients: Record<string, Client>;
  tasks: Record<string, ServedTask>;
  agents: Record<string, Agent>;
  calls: Record<string, Call>;
  conversations: Record<string, Conversation>;
  next: number;
};

export const A2ADoc = defineDoc<A2AState>({
  kind: "a2a.state",
  version: 1,
  scope: "session",
  initial: () => empty(),
});

export function empty(): A2AState {
  return { clients: {}, tasks: {}, agents: {}, calls: {}, conversations: {}, next: 1 };
}

/** Tasks kept per client once they ended, newest first, for `GetTask` and `ListTasks`. */
export const KEEP_TASKS = 100;
/** Calls and conversations kept once done. */
export const KEEP_CALLS = 100;
/** Messages kept in a task's history. */
export const MAX_HISTORY = 20;

export const TERMINAL = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);
/** States in which the agent waits for the caller. */
export const INTERRUPTED = new Set(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]);

/** Drops the oldest ended tasks past `KEEP_TASKS` per client, and old calls and conversations. */
export function prune(state: A2AState): void {
  const ended = Object.values(state.tasks)
    .filter((task) => TERMINAL.has(task.task.status.state))
    .sort((a, b) => b.createdAt - a.createdAt);
  const kept = new Map<string, number>();
  for (const task of ended) {
    const count = (kept.get(task.clientId) ?? 0) + 1;
    kept.set(task.clientId, count);
    if (count > KEEP_TASKS) delete state.tasks[task.id];
  }
  const done = Object.values(state.calls)
    .filter((call) => call.status === "done")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const call of done.slice(KEEP_CALLS)) delete state.calls[call.id];
  const conversations = Object.entries(state.conversations).sort(
    ([, a], [, b]) => b.updatedAt - a.updatedAt,
  );
  for (const [id] of conversations.slice(KEEP_CALLS)) delete state.conversations[id];
}
