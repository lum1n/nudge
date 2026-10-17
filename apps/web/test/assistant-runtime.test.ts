import { type AppendMessage, fromThreadMessageLike } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  activity,
  appendText,
  buildQueueAdapter,
  progressLine,
  toThreadMessageLike,
  transcript,
} from "../src/assistant-runtime.ts";
import type { QueuedMessage, TimelineItem } from "@nudge/client";

describe("toThreadMessageLike", () => {
  it("gives a running tool's last line of output as its progress, and drops it once done", () => {
    const answer = (status: "running" | "done"): TimelineItem => ({
      type: "answer",
      id: "answer:1",
      status: "running",
      parts: [
        {
          type: "tool",
          callId: "c1",
          name: "browse",
          args: { task: "Find a GLC" },
          status,
          ...(status === "done"
            ? { result: "Found three.", details: { steps: 3 } }
            : { output: 'Starting the browser…\nClicking "Search"…\n' }),
        },
      ],
    });
    expect(toThreadMessageLike(answer("running"), "ann").content).toMatchObject([
      { type: "tool-call", artifact: { progress: 'Clicking "Search"…' } },
    ]);
    expect(toThreadMessageLike(answer("done"), "ann").content).toMatchObject([
      { type: "tool-call", result: "Found three.", artifact: { steps: 3 } },
    ]);
    expect(progressLine("\n\n")).toBeUndefined();
    expect(progressLine(`${"x".repeat(150)}\n`)).toHaveLength(100);
  });

  it("names the author, and marks my own messages", () => {
    const message: TimelineItem = {
      type: "user",
      id: "user:1",
      text: "hi",
      author: { id: "ann", displayName: "Ann" },
      sentAt: 1000,
    };
    expect(toThreadMessageLike(message, "ann")).toMatchObject({
      role: "user",
      content: "hi",
      metadata: { custom: { author: "Ann", mine: true } },
    });
    expect(toThreadMessageLike(message, "bo")).toMatchObject({
      metadata: { custom: { author: "Ann", mine: false } },
    });
  });

  // assistant-ui's own conversion runs too: it refuses system messages that aren't one text part.
  const accepted = (item: TimelineItem) =>
    fromThreadMessageLike(toThreadMessageLike(item, "ann"), item.id, {
      type: "complete",
      reason: "unknown",
    });

  it("carries a fired nudge as a system line with its kind in metadata", () => {
    const nudge: TimelineItem = { type: "nudge", id: "nudge:2", text: "Kettle", firedAt: 2000 };
    expect(accepted(nudge)).toMatchObject({
      role: "system",
      content: [{ type: "text", text: "Kettle" }],
      createdAt: new Date(2000),
      metadata: { custom: { kind: "nudge", text: "Kettle" } },
    });
  });

  it("carries a marker as a system line with its kind in metadata", () => {
    const marker: TimelineItem = { type: "marker", id: "marker:3", kind: "reset" };
    expect(accepted(marker)).toMatchObject({
      role: "system",
      metadata: { custom: { kind: "marker", marker: "reset" } },
    });
  });

  it("carries how an approval ended as a system line", () => {
    const approval: TimelineItem = {
      type: "approval",
      id: "approval:4",
      approvalId: "a1",
      summary: "Send a mail",
      status: "done",
      decidedBy: "Bo",
    };
    expect(accepted(approval)).toMatchObject({
      role: "system",
      metadata: {
        custom: {
          kind: "approval",
          id: "a1",
          summary: "Send a mail",
          status: "done",
          decidedBy: "Bo",
        },
      },
    });
  });

  it("maps assistant parts and status, including a failed answer's error", () => {
    const answer: TimelineItem = {
      type: "answer",
      id: "answer:1",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "hello" },
        {
          type: "tool",
          callId: "c1",
          name: "remember",
          args: { fact: "x" },
          status: "done",
          result: "ok",
          isError: false,
          details: { needsLogin: true },
        },
      ],
      status: "failed",
      error: "Overloaded",
    };
    expect(toThreadMessageLike(answer, "ann")).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "hello" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "remember",
          result: "ok",
          isError: false,
          artifact: { needsLogin: true },
        },
      ],
      status: { type: "incomplete", reason: "error", error: "Overloaded" },
    });
  });

  it("maps a running answer to a running status, and a stopped one to incomplete/cancelled", () => {
    const base: TimelineItem = { type: "answer", id: "a", parts: [], status: "running" };
    expect(toThreadMessageLike(base, "ann")).toMatchObject({ status: { type: "running" } });
    expect(toThreadMessageLike({ ...base, status: "stopped" }, "ann")).toMatchObject({
      status: { type: "incomplete", reason: "cancelled" },
    });
    expect(toThreadMessageLike({ ...base, status: "done" }, "ann")).toMatchObject({
      status: { type: "complete", reason: "stop" },
    });
  });
});

describe("transcript and activity", () => {
  const tool = (callId: string, details?: unknown) => ({
    type: "tool" as const,
    callId,
    name: callId === "login" ? "browse" : "call_api",
    args: {},
    status: "done" as const,
    result: "ok",
    ...(details === undefined ? {} : { details }),
  });
  const timeline: TimelineItem[] = [
    { type: "nudge", id: "n", text: "Watch w1: 2 new", firedAt: 1 },
    {
      type: "answer",
      id: "a1",
      status: "done",
      parts: [
        { type: "reasoning", text: "hm" },
        tool("c1"),
        tool("login", { needsLogin: true }),
        tool("ask", { approval: "p1" }),
        tool("old", { approval: "p0" }),
        { type: "text", text: "Two new mails." },
      ],
    },
    { type: "approval", id: "ap", approvalId: "p0", summary: "Send", status: "done" },
    { type: "answer", id: "a2", status: "done", parts: [tool("c2")] },
    { type: "answer", id: "a3", status: "running", parts: [tool("c3")] },
    { type: "marker", id: "m", kind: "reset" },
  ];
  const approvals = [
    { id: "p1", summary: "Pay", status: "pending" as const },
    { id: "p0", summary: "Send", status: "done" as const },
  ] as unknown as Parameters<typeof transcript>[1];

  it("keeps messages and the answers' text, and only the tools waiting on the reader", () => {
    expect(transcript(timeline, approvals)).toMatchObject([
      {
        id: "a1",
        parts: [{ callId: "login" }, { callId: "ask" }, { type: "text", text: "Two new mails." }],
      },
      { id: "a3", status: "running", parts: [] },
      { id: "m" },
    ]);
  });

  it("keeps someone else's private answer, which comes without parts", () => {
    const secret: TimelineItem = {
      type: "answer",
      id: "s",
      status: "done",
      parts: [],
      privateTo: { id: "bo", displayName: "Bo" },
    };
    expect(transcript([secret], [])).toEqual([secret]);
  });

  it("gives nudges, ended approvals and each answer's tools and thinking to the activity", () => {
    const items = activity(timeline);
    expect(items.map((item) => item.id)).toEqual(["n", "a1", "ap", "a2", "a3"]);
    expect(items[1]).toMatchObject({ parts: { length: 5 } });
    expect(JSON.stringify(items)).not.toContain("Two new mails.");
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
      { id: 1, mode: "followUp", text: "a", nudge: false },
      { id: 2, mode: "steer", text: "b", nudge: false },
    ];
    const adapter = buildQueueAdapter(queue, [], dispatch);
    expect(adapter.items).toMatchObject([{ id: "1", prompt: "a" }]);
    expect(adapter.steerItems).toMatchObject([{ id: "2", prompt: "b" }]);
  });

  it("adds pending sends not yet in the view, by lane, but not failed ones", () => {
    const adapter = buildQueueAdapter(
      [],
      [
        { requestId: "r1", text: "c" },
        { requestId: "r2", text: "d", whenBusy: "steer" },
        { requestId: "r3", text: "e", error: "Offline" },
      ],
      dispatch,
    );
    expect(adapter.items).toMatchObject([{ id: "r1", prompt: "c" }]);
    expect(adapter.steerItems).toMatchObject([{ id: "r2", prompt: "d" }]);
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
