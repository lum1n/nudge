import { describe, expect, it } from "vitest";
import { type TerminalCommand, terminalCommands } from "../src/terminal.ts";

const ls: TerminalCommand = {
  id: "c1",
  command: "ls",
  status: "running",
  output: "a\n",
  startedAt: 1,
};

describe("the terminal's commands", () => {
  it("adds streamed output to the command it belongs to", () => {
    const pick = terminalCommands();
    expect(pick({ type: "commands", commands: [ls] })).toEqual([ls]);
    expect(pick({ type: "output", id: "c1", chunk: "b\n" })).toEqual([{ ...ls, output: "a\nb\n" }]);
    expect(pick({ type: "output", id: "c9", chunk: "x" })).toEqual([{ ...ls, output: "a\nb\n" }]);
    expect(pick({ type: "commands", commands: [] })).toEqual([]);
  });
});
