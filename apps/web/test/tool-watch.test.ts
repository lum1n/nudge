import { describe, expect, it } from "vitest";
import type { AssistantPart, ThreadMessage } from "../src/thread.ts";
import { newlyDoneToolCalls } from "../src/tool-watch.ts";

const assistant = (parts: readonly AssistantPart[]): ThreadMessage => ({
  role: "assistant",
  id: "a1",
  parts,
  status: "done",
});

describe("newlyDoneToolCalls", () => {
  it("finds a done call among the watched tool names that is not already seen", () => {
    const messages = [
      assistant([
        { type: "text", text: "Sure." },
        { type: "tool-call", toolCallId: "c1", toolName: "remember", args: {}, status: "done" },
      ]),
    ];
    const found = newlyDoneToolCalls(messages, new Set(["remember", "forget"]), new Set());
    expect(found).toEqual([{ toolCallId: "c1", toolName: "remember" }]);
  });

  it("ignores calls that are not done, not watched, or already seen", () => {
    const messages = [
      assistant([
        { type: "tool-call", toolCallId: "c1", toolName: "remember", args: {}, status: "running" },
        { type: "tool-call", toolCallId: "c2", toolName: "roll_dice", args: {}, status: "done" },
        { type: "tool-call", toolCallId: "c3", toolName: "remember", args: {}, status: "done" },
      ]),
    ];
    const found = newlyDoneToolCalls(messages, new Set(["remember"]), new Set(["c3"]));
    expect(found).toEqual([]);
  });
});
