import type { ThreadMessage } from "./thread.ts";

export type DoneToolCall = { readonly toolCallId: string; readonly toolName: string };

/**
 * Tool calls among `messages` that just finished (status `"done"`), are one of `toolNames`, and
 * are not already in `seen`. The only signal the browser has for "a `remember`/`schedule_nudge`
 * tool result landed": there is no separate tool-result stream, only the thread's own messages.
 */
export function newlyDoneToolCalls(
  messages: readonly ThreadMessage[],
  toolNames: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): readonly DoneToolCall[] {
  const found: DoneToolCall[] = [];
  for (const message of messages)
    if (message.role === "assistant")
      for (const part of message.parts)
        if (
          part.type === "tool-call" &&
          part.status === "done" &&
          toolNames.has(part.toolName) &&
          !seen.has(part.toolCallId)
        )
          found.push({ toolCallId: part.toolCallId, toolName: part.toolName });
  return found;
}
