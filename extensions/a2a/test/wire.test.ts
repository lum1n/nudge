import { describe, expect, it } from "vitest";
import { empty, KEEP_CALLS, KEEP_TASKS, prune, type ServedTask } from "../src/model.ts";
import { cut, reachable, stateName, textOfParts, textOfTask } from "../src/wire.ts";

describe("reachable", () => {
  it("takes HTTPS, and plain HTTP only to Wired hosts or when insecure", () => {
    expect(reachable("https://agent.example.com/a2a", false)).toBe(true);
    expect(reachable("http://agent.example.com/a2a", false)).toBe(false);
    expect(reachable("http://127.0.0.1:4000/a2a", true)).toBe(true);
    expect(reachable("http://nudge.robin.wired/a2a", false)).toBe(true);
    expect(reachable("http://robin.wired/a2a", false)).toBe(false);
  });

  it("refuses other schemes and what isn't a URL, even when insecure", () => {
    expect(reachable("file:///etc/passwd", true)).toBe(false);
    expect(reachable("ftp://agent.example.com", true)).toBe(false);
    expect(reachable("not a url", true)).toBe(false);
  });
});

describe("textOfParts", () => {
  it("gives text as is, data as JSON, and files by name or link only", () => {
    expect(
      textOfParts([
        { text: "Booked." },
        { data: { table: 4 } },
        { url: "https://example.com/r.pdf", filename: "receipt.pdf" },
        { raw: "aGk=", filename: "" },
      ]),
    ).toBe(
      'Booked.\n\n```json\n{\n  "table": 4\n}\n```\n\n' +
        "(receipt.pdf: https://example.com/r.pdf)\n\n(a file came along; it isn't read here)",
    );
  });

  it("drops empty parts, and has nothing to say without parts", () => {
    expect(textOfParts([{ text: "  " }, {}, { text: "Hi" }])).toBe("Hi");
    expect(textOfParts(undefined)).toBe("");
  });
});

describe("textOfTask", () => {
  it("gives the status message, then each artifact", () => {
    expect(
      textOfTask({
        id: "t1",
        contextId: "c1",
        status: {
          state: "TASK_STATE_COMPLETED",
          message: { messageId: "m1", role: "ROLE_AGENT", parts: [{ text: "Done." }] },
        },
        artifacts: [
          { artifactId: "a1", parts: [{ text: "First" }] },
          { artifactId: "a2", parts: [] },
          { artifactId: "a3", parts: [{ text: "Second" }] },
        ],
      }),
    ).toBe("Done.\n\nFirst\n\nSecond");
    expect(textOfTask({ id: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING" } })).toBe(
      "",
    );
  });
});

describe("cut and stateName", () => {
  it("cuts long text to the length asked, ellipsis included", () => {
    expect(cut("hello", 5)).toBe("hello");
    expect(cut("hello world", 5)).toBe("hell…");
    expect(cut("hello world", 5)).toHaveLength(5);
  });

  it("puts a task state in words", () => {
    expect(stateName("TASK_STATE_INPUT_REQUIRED")).toBe("input required");
    expect(stateName("TASK_STATE_COMPLETED")).toBe("completed");
  });
});

describe("prune", () => {
  const task = (id: string, clientId: string, state: string, createdAt: number): ServedTask => ({
    id,
    clientId,
    messageId: `m-${id}`,
    task: { id, contextId: "c", status: { state } },
    push: [],
    createdAt,
  });

  it("keeps the newest ended tasks per client, and every task still going", () => {
    const state = empty();
    for (let i = 0; i < KEEP_TASKS + 2; i++) {
      state.tasks[`a${i}`] = task(`a${i}`, "c1", "TASK_STATE_COMPLETED", i);
      state.tasks[`b${i}`] = task(`b${i}`, "c2", "TASK_STATE_FAILED", i);
    }
    state.tasks.working = task("working", "c1", "TASK_STATE_WORKING", -1);
    state.tasks.asking = task("asking", "c1", "TASK_STATE_INPUT_REQUIRED", -2);
    prune(state);
    const ids = Object.keys(state.tasks);
    expect(ids).toHaveLength(KEEP_TASKS * 2 + 2);
    expect(ids).not.toContain("a0");
    expect(ids).not.toContain("a1");
    expect(ids).not.toContain("b0");
    expect(ids).toContain("a2");
    expect(ids).toContain(`a${KEEP_TASKS + 1}`);
    expect(ids).toContain("working");
    expect(ids).toContain("asking");
  });

  it("drops the oldest done calls and conversations, and no open call", () => {
    const state = empty();
    for (let i = 0; i < KEEP_CALLS + 1; i++) {
      state.calls[`k${i}`] = {
        id: `k${i}`,
        agentId: "g1",
        contextId: "c",
        taskId: `t${i}`,
        state: "TASK_STATE_COMPLETED",
        roomId: "r",
        asked: "?",
        pushToken: "p",
        status: "done",
        deadline: 0,
        createdAt: i,
      };
      state.conversations[`v${i}`] = {
        agentId: "g1",
        state: "TASK_STATE_COMPLETED",
        roomId: "r",
        updatedAt: i,
      };
    }
    state.calls.open = { ...state.calls.k0!, id: "open", status: "open", createdAt: -1 };
    prune(state);
    expect(Object.keys(state.calls)).toHaveLength(KEEP_CALLS + 1);
    expect(state.calls.k0).toBeUndefined();
    expect(state.calls.open).toBeDefined();
    expect(Object.keys(state.conversations)).toHaveLength(KEEP_CALLS);
    expect(state.conversations.v0).toBeUndefined();
    expect(state.conversations[`v${KEEP_CALLS}`]).toBeDefined();
  });
});
