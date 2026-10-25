import { useState } from "react";
import { type PanelSocketState, usePanelSocket } from "./panel-socket.ts";

/** A command of the room's terminal (`TerminalCommand` in `@nudge/ext-terminal`). */
export type TerminalCommand = {
  id: string;
  command: string;
  cwd?: string;
  status: "waiting" | "running" | "done" | "failed" | "stopped" | "denied";
  approval?: string;
  decidedBy?: string;
  output: string;
  exitCode?: number;
  ending?: string;
  startedAt: number;
  endedAt?: number;
};

export type TerminalFrame =
  | { type: "commands"; commands: TerminalCommand[] }
  | { type: "output"; id: string; chunk: string };

/**
 * The commands the assistant ran in the room's terminal, oldest first, with their output as it
 * comes. The panel is only watched; approvals go through the room's API.
 */
export function useTerminal(assistant: string, room: string): PanelSocketState<TerminalCommand[]> {
  const [picker] = useState(terminalCommands);
  return usePanelSocket<TerminalCommand[], never, TerminalFrame>(
    assistant,
    room,
    "terminal",
    picker,
  )[1];
}

/**
 * Picks the commands out of the panel's frames: output frames add to what the last `commands`
 * frame gave, and each connection starts with one.
 */
export function terminalCommands(): (frame: TerminalFrame) => TerminalCommand[] | undefined {
  let commands: TerminalCommand[] = [];
  return (frame) => {
    if (frame.type === "commands") return (commands = frame.commands);
    if (frame.type !== "output") return undefined;
    return (commands = commands.map((command) =>
      command.id === frame.id ? { ...command, output: command.output + frame.chunk } : command,
    ));
  };
}
