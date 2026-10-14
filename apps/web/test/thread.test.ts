import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type Thread, type ThreadMessage, ThreadReader } from "../src/thread.ts";
import { replay } from "./replay.ts";

const views = replay();
const readAll = (me: string) => {
  const reader = new ThreadReader();
  return views.map((view) => reader.read(view, me));
};

const summary = (message: ThreadMessage) =>
  message.role === "assistant"
    ? `assistant(${message.status}): ${message.parts.map((p) => (p.type === "tool-call" ? `${p.toolName}()` : p.text)).join(" | ")}`
    : message.role === "user"
      ? `${message.author?.displayName}${message.mine ? " (me)" : ""}: ${message.text}`
      : message.role === "nudge"
        ? `nudge: ${message.text}`
        : message.role === "approval"
          ? `approval ${message.approvalId} ${message.status}: ${message.summary}`
          : `marker: ${message.kind}`;

describe("ThreadReader", () => {
  it("shows the run as messages: authors, an answer with its tool round, and the fired nudge", () => {
    const thread = readAll("ann").at(-1)!;
    expect(thread.messages.map(summary)).toEqual([
      "Ann (me): Remember that I like tea",
      "assistant(done): Ann wants this kept. | I'll note that. | remember() | Noted: Ann likes tea.",
      "Bo: I like coffee",
      "assistant(done): And Bo likes coffee.",
      "nudge: Kettle",
      "assistant(done): Time to put the kettle on!",
    ]);
    const answer = thread.messages[1] as Extract<ThreadMessage, { role: "assistant" }>;
    expect(answer.parts[0]).toMatchObject({ type: "reasoning" });
    expect(answer.parts[2]).toMatchObject({
      type: "tool-call",
      toolName: "remember",
      args: { fact: "Ann likes tea" },
      status: "done",
      isError: false,
    });
    expect((answer.parts[2] as { result?: string }).result).toBeTruthy();
    expect(thread.isRunning).toBe(false);
    expect(thread.queue).toEqual([]);
    expect(thread.status).toBeUndefined();
  });

  it("shows the answer in flight, and its tool call while it runs", () => {
    const threads = readAll("ann");
    const trailing = (thread: Thread) => thread.messages.at(-1) ?? { role: "none" as const };

    const thinking = threads.find((thread) => {
      const last = trailing(thread);
      return last.role === "assistant" && last.parts.some((part) => part.type === "reasoning");
    })!;
    expect(thinking.isRunning).toBe(true);
    expect(trailing(thinking)).toMatchObject({ role: "assistant", status: "running" });

    const running = threads.find((thread) => {
      const last = trailing(thread);
      return (
        last.role === "assistant" &&
        last.parts.some((part) => part.type === "tool-call" && part.status === "running")
      );
    });
    expect(running).toBeDefined();
    expect(trailing(running!)).toMatchObject({ status: "running" });

    // The in-flight answer keeps its id once its entry is written.
    const ids = new Set(
      threads.flatMap((thread) =>
        thread.messages.filter((m) => m.role === "assistant").map((m) => m.id),
      ),
    );
    expect(ids.size).toBe(3);
  });

  it("lists Bo's message as queued while the assistant is busy, mine only for Bo", () => {
    const queued = readAll("ann").find((thread) => thread.queue.length > 0)!;
    expect(queued.isRunning).toBe(true);
    expect(queued.queue).toMatchObject([
      { mode: "followUp", text: "I like coffee", author: { displayName: "Bo" }, mine: false },
    ]);
    const asBo = readAll("bo").find((thread) => thread.queue.length > 0)!;
    expect(asBo.queue[0]!.mine).toBe(true);
  });

  it("hands back the same message objects while their sources stay the same", () => {
    const threads = readAll("ann");
    const first = threads.find((thread) => thread.messages.length > 0)!.messages[0]!;
    for (const thread of threads.filter((t) => t.messages.length > 0))
      expect(thread.messages[0]).toBe(first);
    const done = threads.at(-1)!.messages[1]!;
    expect(threads.at(-2)!.messages[1]).toBe(done);
  });

  it("marks stopped and failed answers, and where the transcript starts over", () => {
    const base = views.at(-1)!;
    const assistant = (stopReason: string, errorMessage?: string, id = 100) => ({
      id,
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Half an ans" }],
          stopReason,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        },
      ],
    });
    const view = {
      ...base,
      entries: [
        { id: 1, conversationId: 1, kind: "pi.compaction", data: {} },
        { id: 2, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
        assistant("aborted", undefined, 3),
        { id: 4, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "again" }] },
        assistant("error", "Overloaded", 5),
      ],
    } as unknown as ConversationView;
    const thread = new ThreadReader().read(view, "ann");
    expect(thread.messages.map(summary)).toEqual([
      "marker: compacted",
      "undefined: hi",
      "assistant(stopped): Half an ans",
      "undefined: again",
      "assistant(failed): Half an ans",
    ]);
    expect(thread.messages[4]).toMatchObject({ error: "Overloaded" });
  });

  it("puts earlier history before the view's own entries", () => {
    const base = views.at(-1)!;
    const view = {
      ...base,
      entries: [
        { id: 10, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "later" }] },
      ],
    } as unknown as ConversationView;
    const earlier = [
      { id: 1, conversationId: 1, kind: "pi.compaction", data: {} },
      {
        id: 2,
        conversationId: 1,
        kind: "pi.user",
        model: [{ role: "user", content: "earlier" }],
      },
    ] as unknown as ConversationView["entries"];
    const thread = new ThreadReader().read(view, "ann", earlier);
    expect(thread.messages.map(summary)).toEqual([
      "marker: compacted",
      "undefined: earlier",
      "undefined: later",
    ]);
  });

  it("carries a tool result's details, for UIs such as the browser's login button", () => {
    const base = views.at(-1)!;
    const view = {
      ...base,
      entries: [
        { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "log in" }] },
        {
          id: 2,
          conversationId: 1,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "c1", name: "browse", arguments: { task: "x" } }],
              stopReason: "toolUse",
            },
          ],
        },
        {
          id: 3,
          conversationId: 1,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "c1",
              toolName: "browse",
              content: [{ type: "text", text: "Login needed on finn.no" }],
              details: { needsLogin: true },
              isError: false,
            },
          ],
        },
      ],
    } as unknown as ConversationView;
    const answer = new ThreadReader().read(view, "ann").messages.at(-1);
    expect(answer).toMatchObject({
      role: "assistant",
      parts: [{ type: "tool-call", toolName: "browse", details: { needsLogin: true } }],
    });
  });

  it("shows how an approval ended between the answers around it", () => {
    const base = views.at(-1)!;
    const view = {
      ...base,
      entries: [
        {
          id: 1,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "mail Ann" }],
        },
        {
          id: 2,
          conversationId: 1,
          kind: "nudge.approval",
          data: { id: "a1", summary: "Send a mail to Ann", status: "done", decidedBy: "Bo" },
          model: [{ role: "user", content: "Bo approved a1" }],
        },
      ],
    } as unknown as ConversationView;
    const thread = new ThreadReader().read(view, "ann");
    expect(thread.messages.map(summary)).toEqual([
      "undefined: mail Ann",
      "approval a1 done: Send a mail to Ann",
    ]);
    expect(thread.messages.at(-1)).toMatchObject({ decidedBy: "Bo" });
  });
});
