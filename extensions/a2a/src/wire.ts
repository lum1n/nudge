import { randomUUID } from "node:crypto";
import { isWiredHost, untrustedData } from "@nudge/core";
import type { MessageJson, PartJson, TaskJson } from "./model.ts";

/** The A2A version this extension speaks. */
export const A2A_VERSION = "1.0";

/**
 * An outside agent's words, marked as untrusted data (ADR 20): the model takes them as what it
 * says, not as orders, and a turn that read them asks before it sends anything out.
 */
export function wrapped(name: string, text: string): string {
  return `${name}, an outside agent, says:\n${untrustedData(`a2a agent ${name}`, text)}`;
}

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** What parts say, as text: data as JSON, files only named. */
export function textOfParts(parts: readonly PartJson[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (part.data !== undefined)
        return "```json\n" + JSON.stringify(part.data, null, 2) + "\n```";
      const name = part.filename === undefined || part.filename === "" ? "a file" : part.filename;
      if (typeof part.url === "string") return `(${name}: ${part.url})`;
      if (part.raw !== undefined) return `(${name} came along; it isn't read here)`;
      return "";
    })
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

export function agentMessage(text: string, contextId: string, taskId: string): MessageJson {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: "ROLE_AGENT",
    parts: [{ text, mediaType: "text/plain" }],
  };
}

export function userMessage(text: string, contextId?: string, taskId?: string): MessageJson {
  return {
    messageId: randomUUID(),
    ...(contextId === undefined ? {} : { contextId }),
    ...(taskId === undefined ? {} : { taskId }),
    role: "ROLE_USER",
    parts: [{ text, mediaType: "text/plain" }],
  };
}

/** What a task has to say: its status message, then its artifacts. */
export function textOfTask(task: TaskJson): string {
  return [
    textOfParts(task.status.message?.parts),
    ...(task.artifacts ?? []).map((artifact) => textOfParts(artifact.parts)),
  ]
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/** A state such as `TASK_STATE_INPUT_REQUIRED` in words. */
export function stateName(state: string): string {
  return state
    .replace(/^TASK_STATE_/, "")
    .replaceAll("_", " ")
    .toLowerCase();
}

/**
 * Whether `url` may be written to from here: over HTTPS, or Wired, which encrypts on its own.
 * Plain HTTP only when `insecure` is on, for local tests.
 */
export function reachable(url: string, insecure: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    return insecure || isWiredHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** A copy of something read in a commit, which outlives it. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
