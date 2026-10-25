import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "./sandbox.ts";

/** How a command in the room's terminal stands. */
export type CommandStatus = "waiting" | "running" | "done" | "failed" | "stopped" | "denied";

/** One command of the room's terminal, as its panel shows it. */
export type TerminalCommand = {
  /** `c1`, `c2`, … within its room. */
  id: string;
  command: string;
  cwd?: string;
  status: CommandStatus;
  /** The approval it waits for, or waited for. */
  approval?: string;
  /** Who approved or denied it. */
  decidedBy?: string;
  /** Its output so far, stdout and stderr together; only the end past `MAX_KEPT`. */
  output: string;
  exitCode?: number;
  /** Why it stopped, when it did not end on its own. */
  ending?: string;
  /** ms since the epoch. */
  startedAt: number;
  endedAt?: number;
  /** Asked for in answer to something private: only this player sees it. */
  privateTo?: string;
};

/** What the panel sends: every command the viewer may see, and output as it comes. */
export type TerminalFrame =
  | { type: "commands"; commands: TerminalCommand[] }
  | { type: "output"; id: string; chunk: string };

/** Commands kept per room; the oldest go first. */
export const KEEP = 30;
/** Most characters of a command's output the panel keeps: its end. */
export const MAX_KEPT = 50_000;

type Viewer = { readonly playerId: string; readonly send: (frame: TerminalFrame) => void };

type Room = { commands: TerminalCommand[]; next: number };

/**
 * The commands of each room's terminal, for the people in the room to watch: what the assistant
 * ran, what it printed, and what waits for approval. Kept in `dir` when there is one, so they
 * outlive a restart; output that streams is saved once the command ends.
 */
export class TerminalLog {
  private readonly rooms = new Map<number, Room>();
  private readonly viewers = new Map<number, Set<Viewer>>();

  constructor(
    private readonly dir: string | undefined,
    private readonly now: () => number,
  ) {}

  /** A command that runs now. */
  start(conversationId: number, draft: Draft): TerminalCommand {
    return this.add(conversationId, draft, "running");
  }

  /** A command that waits for `approval`. */
  wait(conversationId: number, draft: Draft, approval: string): TerminalCommand {
    return this.add(conversationId, { ...draft, approval }, "waiting");
  }

  /** The command waiting for `approval` runs now; a new one when none waits, as after a restart. */
  approved(conversationId: number, approval: string, draft: Draft, by: string): TerminalCommand {
    const found = this.byApproval(conversationId, approval);
    if (found === undefined)
      return this.add(conversationId, { ...draft, approval, decidedBy: by }, "running");
    Object.assign(found, { status: "running", decidedBy: by, startedAt: this.now() });
    this.changed(conversationId);
    return found;
  }

  denied(conversationId: number, approval: string, by: string): void {
    const found = this.byApproval(conversationId, approval);
    if (found === undefined) return;
    Object.assign(found, { status: "denied", decidedBy: by, endedAt: this.now() });
    this.changed(conversationId);
  }

  output(conversationId: number, id: string, chunk: string): void {
    const found = this.room(conversationId).commands.find((command) => command.id === id);
    if (found === undefined || chunk === "") return;
    found.output = keepEnd(found.output + chunk);
    for (const viewer of this.viewers.get(conversationId) ?? [])
      if (sees(viewer, found)) viewer.send({ type: "output", id, chunk });
  }

  /** How the command ended; its whole output (as the model got it) replaces what streamed. */
  finish(conversationId: number, id: string, result: CommandResult, ending?: string): void {
    const found = this.room(conversationId).commands.find((command) => command.id === id);
    if (found === undefined) return;
    found.output = keepEnd(result.output);
    found.status = ending ? "stopped" : result.exitCode === 0 ? "done" : "failed";
    if (result.exitCode !== undefined) found.exitCode = result.exitCode;
    if (ending) found.ending = ending;
    found.endedAt = this.now();
    this.changed(conversationId);
  }

  /** It could not run at all. */
  fail(conversationId: number, id: string, message: string): void {
    const found = this.room(conversationId).commands.find((command) => command.id === id);
    if (found === undefined) return;
    Object.assign(found, { status: "failed", ending: message, endedAt: this.now() });
    this.changed(conversationId);
  }

  /** Sends `send` the room's commands now and whenever they change, until the returned stop. */
  watch(conversationId: number, playerId: string, send: Viewer["send"]): () => void {
    const viewer: Viewer = { playerId, send };
    let viewers = this.viewers.get(conversationId);
    if (viewers === undefined) this.viewers.set(conversationId, (viewers = new Set()));
    viewers.add(viewer);
    send(this.frameFor(conversationId, viewer));
    return () => {
      viewers.delete(viewer);
      if (viewers.size === 0) this.viewers.delete(conversationId);
    };
  }

  /** What `playerId` sees of a room's commands, oldest first. */
  commands(conversationId: number, playerId: string): TerminalCommand[] {
    return this.room(conversationId).commands.filter((command) => sees({ playerId }, command));
  }

  private add(
    conversationId: number,
    draft: Draft & { approval?: string; decidedBy?: string },
    status: CommandStatus,
  ): TerminalCommand {
    const room = this.room(conversationId);
    const command: TerminalCommand = {
      id: `c${room.next++}`,
      command: draft.command,
      ...(draft.cwd ? { cwd: draft.cwd } : {}),
      status,
      ...(draft.approval ? { approval: draft.approval } : {}),
      ...(draft.decidedBy ? { decidedBy: draft.decidedBy } : {}),
      output: "",
      startedAt: this.now(),
      ...(draft.privateTo ? { privateTo: draft.privateTo } : {}),
    };
    room.commands.push(command);
    room.commands.splice(0, Math.max(0, room.commands.length - KEEP));
    this.changed(conversationId);
    return command;
  }

  private byApproval(conversationId: number, approval: string): TerminalCommand | undefined {
    return this.room(conversationId).commands.findLast(
      (command) => command.approval === approval && command.status === "waiting",
    );
  }

  private frameFor(conversationId: number, viewer: { playerId: string }): TerminalFrame {
    return { type: "commands", commands: this.commands(conversationId, viewer.playerId) };
  }

  private changed(conversationId: number): void {
    this.save(conversationId);
    for (const viewer of this.viewers.get(conversationId) ?? [])
      viewer.send(this.frameFor(conversationId, viewer));
  }

  private room(conversationId: number): Room {
    let room = this.rooms.get(conversationId);
    if (room === undefined) this.rooms.set(conversationId, (room = this.load(conversationId)));
    return room;
  }

  private file(conversationId: number): string | undefined {
    return this.dir && join(this.dir, `conversation-${conversationId}.json`);
  }

  private load(conversationId: number): Room {
    const file = this.file(conversationId);
    if (file === undefined) return { commands: [], next: 1 };
    try {
      const room = JSON.parse(readFileSync(file, "utf8")) as Room;
      // What ran or waited when the server stopped never finishes now.
      for (const command of room.commands)
        if (command.status === "running")
          Object.assign(command, { status: "stopped", ending: "the server restarted" });
      return room;
    } catch {
      return { commands: [], next: 1 };
    }
  }

  private save(conversationId: number): void {
    const file = this.file(conversationId);
    if (file === undefined || this.dir === undefined) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(this.room(conversationId)));
      renameSync(`${file}.tmp`, file);
    } catch {
      // The log is for watching; a full disk must not fail the command.
    }
  }
}

/** What a command is before it has an id. */
export type Draft = { command: string; cwd?: string; privateTo?: string };

const sees = (viewer: { playerId: string }, command: TerminalCommand) =>
  command.privateTo === undefined || command.privateTo === viewer.playerId;

const keepEnd = (output: string) =>
  output.length <= MAX_KEPT ? output : output.slice(output.length - MAX_KEPT);

// Module state, like the browser's viewers: it outlives `nudge reload`, which re-imports only the
// entry module, so commands that run across a reload still finish in the log.
const logs = new Map<string, TerminalLog>();

/** The log kept in `dir`; a fresh one without a directory, as for an in-memory assistant. */
export function terminalLog(dir: string | undefined, now: () => number): TerminalLog {
  if (dir === undefined) return new TerminalLog(undefined, now);
  let log = logs.get(dir);
  if (log === undefined) logs.set(dir, (log = new TerminalLog(dir, now)));
  return log;
}
