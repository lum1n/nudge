import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { appendText, buildQueueAdapter, toThreadMessageLike } from "../src/assistant-runtime.ts";
import type { QueuedMessage, ThreadMessage } from "../src/thread.ts";

describe("toThreadMessageLike", () => {
  it("names the author, and marks my own messages", () => {
    const mine: ThreadMessage = {
      role: "user",
      id: "entry:1",
      text: "hi",
      author: { playerId: "ann", displayName: "Ann" },
      mine: true,
      sentAt: 1000,
    };
    expect(toThreadMessageLike(mine)).toMatchObject({
      role: "user",
      content: "hi",
      metadata: { custom: { author: "Ann", mine: true } },
    });
    const someoneElse: ThreadMessage = { ...mine, mine: false };
    expect(toThreadMessageLike(someoneElse)).toMatchObject({
      metadata: { custom: { author: "Ann", mine: false } },
    });
  });

  it("carries a fired nudge as a data-nudge system part", () => {
    const nudge: ThreadMessage = { role: "nudge", id: "entry:2", text: "Kettle", firedAt: 2000 };
    expect(toThreadMessageLike(nudge)).toMatchObject({
      role: "system",
      content: [{ type: "data-nudge", data: { text: "Kettle" } }],
      createdAt: new Date(2000),
    });
  });

  it("carries a marker as a data-marker system part", () => {
    const marker: ThreadMessage = { role: "marker", id: "entry:3", kind: "reset" };
    expect(toThreadMessageLike(marker)).toMatchObject({
      role: "system",
      content: [{ type: "data-marker", data: { kind: "reset" } }],
    });
  });

  it("maps assistant parts and status, including a failed answer's error", () => {
    const answer: ThreadMessage = {
      role: "assistant",
      id: "answer:1",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "hello" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "remember",
          args: { fact: "x" },
          status: "done",
          result: "ok",
          isError: false,
        },
      ],
      status: "failed",
      error: "Overloaded",
    };
    expect(toThreadMessageLike(answer)).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "hello" },
        { type: "tool-call", toolCallId: "c1", toolName: "remember", result: "ok", isError: false },
      ],
      status: { type: "incomplete", reason: "error", error: "Overloaded" },
    });
  });

  it("maps a running answer to a running status, and a stopped one to incomplete/cancelled", () => {
    const base: ThreadMessage = { role: "assistant", id: "a", parts: [], status: "running" };
    expect(toThreadMessageLike(base)).toMatchObject({ status: { type: "running" } });
    expect(toThreadMessageLike({ ...base, status: "stopped" })).toMatchObject({
      status: { type: "incomplete", reason: "cancelled" },
    });
    expect(toThreadMessageLike({ ...base, status: "done" })).toMatchObject({
      status: { type: "complete", reason: "stop" },
    });
  });
});

describe("appendText", () => {
  it("joins the text parts of a composed message", () => {
    const message = {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    } as unknown as AppendMessage;
    expect(appendText(message)).toBe("ab");
  });
});

describe("buildQueueAdapter", () => {
  const dispatch = () => {};

  it("sorts the real queue into lanes by mode", () => {
    const queue: QueuedMessage[] = [
      { id: 1, mode: "followUp", text: "a", mine: false, nudge: false },
      { id: 2, mode: "steer", text: "b", mine: false, nudge: false },
    ];
    const adapter = buildQueueAdapter(queue, [], dispatch);
    expect(adapter.items).toMatchObject([{ id: "1", prompt: "a" }]);
    expect(adapter.steerItems).toMatchObject([{ id: "2", prompt: "b" }]);
  });

  it("adds a pending send not yet in the real queue", () => {
    const adapter = buildQueueAdapter(
      [],
      [{ localId: "local:1", text: "c", lane: "queue" }],
      dispatch,
    );
    expect(adapter.items).toMatchObject([{ id: "local:1", prompt: "c" }]);
    expect(adapter.steerItems).toEqual([]);
  });

  it("dispatches enqueue and steer to the given lane", () => {
    const calls: Array<"queue" | "steer"> = [];
    const adapter = buildQueueAdapter([], [], (_message, lane) => calls.push(lane));
    const message = { content: [] } as unknown as AppendMessage;
    adapter.enqueue(message);
    adapter.steer(message);
    expect(calls).toEqual(["queue", "steer"]);
  });
});
