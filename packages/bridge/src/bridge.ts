import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import {
  AdminOnly,
  AlreadyDecided,
  ApprovalNotFound,
  canUse,
  type ExtensionHost,
  type Nudge,
  type Player,
  type Room,
  type RoomEvent,
} from "@nudge/core";

const context = BACKGROUND_CONTEXT;

/** A conversation on the chat service: a direct chat with the bot, or a group it is in. */
export type Chat = { readonly id: string; readonly private: boolean };

/** Who wrote, as the chat service knows them. */
export type Sender = { readonly id: string; readonly name: string };

/** What the chat service delivered. `id` is the service's own, stable across redeliveries. */
export type Inbound =
  | {
      readonly type: "message";
      readonly chat: Chat;
      readonly sender: Sender;
      readonly text: string;
      readonly id: string;
    }
  | {
      /** A button under one of the bridge's messages was pressed. */
      readonly type: "action";
      readonly chat: Chat;
      readonly sender: Sender;
      readonly data: string;
      readonly id: string;
      /** The message the button was under. */
      readonly messageId?: string;
    };

export type Button = { readonly label: string; readonly data: string };

/** What a bridge needs from the chat service. */
export interface Transport {
  /** Lower-case, such as `telegram`; names the client of every link's token. */
  readonly name: string;
  /** Longest message the service takes; longer answers go out in parts. */
  readonly maxLength: number;
  /** Whether `send` can put buttons under a message; without, approvals say which command to send. */
  readonly buttons: boolean;
  /** Sends a message, and returns its id when the service gives one. */
  send(chatId: string, text: string, buttons?: readonly Button[]): Promise<string | undefined>;
  /** Tells the service a button press was handled, with a short note for the presser. */
  answer?(actionId: string, text: string): Promise<void>;
  /** Replaces a message's text and drops its buttons. */
  edit?(chatId: string, messageId: string, text: string): Promise<void>;
}

// Stored in a document, so plain JSON.
type Link = {
  playerId: string;
  /** The client of the token the link made; revoking that token unlinks. */
  clientId: string;
};

export type BridgeState = {
  /** By sender id. */
  links: Record<string, Link>;
  /**
   * The room each chat talks to, by chat id. Direct chats default to the player's own room, and
   * name the player, who alone reads them: only they get what is private to them.
   */
  chats: Record<string, { roomId: string; playerId?: string }>;
  /** Where the transport is in the service's stream, such as Telegram's update offset. */
  cursor?: string;
};

const HELP =
  "Commands: /link <code> links this account to a player (a code from `nudge pair <player>`), " +
  "/rooms lists your rooms, /room <id> picks the room this chat talks to, /approve <id> and " +
  "/deny <id> decide an approval, /whisper <text> sends a message only you see, and the " +
  "answer to it (in a direct chat), /stop stops the answer in progress, /unlink undoes /link. " +
  "Anything else goes to the room as your message.";

/**
 * A chat service linked to the assistant: chats map to rooms and senders to players, messages go
 * in as the player, and the room's answers and approvals come back out. Everything sent out leaves
 * the host in the clear as far as Nudge is concerned; what the chat service does with it is its own.
 */
export class ChatBridge {
  private readonly doc;

  constructor(
    private readonly host: Pick<ExtensionHost<unknown>, "assistant">,
    private readonly transport: Transport,
    /** The extension's name: its doc and its on/off switch per room. */
    private readonly extension: string,
    private readonly report: (error: unknown) => void,
  ) {
    this.doc = defineDoc<BridgeState>({
      kind: `${extension}.bridge`,
      version: 1,
      scope: "session",
      initial: () => ({ links: {}, chats: {} }),
    });
  }

  private get nudge(): Nudge {
    return this.host.assistant();
  }

  async state(): Promise<BridgeState> {
    return (await this.nudge.harness.snapshot(this.doc, context)) ?? { links: {}, chats: {} };
  }

  async setCursor(cursor: string): Promise<void> {
    await this.nudge.harness.commit(async (tx) => {
      (await tx.doc(this.doc)).cursor = cursor;
    }, context);
  }

  /** Handles one delivery; answers the chat itself, so it only throws on a fault. */
  async receive(inbound: Inbound): Promise<void> {
    if (inbound.type === "action") return this.action(inbound);
    const text = inbound.text.trim();
    if (text === "") return;
    const [word = "", ...rest] = text.split(/\s+/);
    const command = /^\/([a-z]+)(@\S+)?$/i.exec(word)?.[1]?.toLowerCase();
    const argument = rest.join(" ");
    const reply = (message: string) => this.say(inbound.chat.id, message);
    if (command === "start" || command === "help") return reply(HELP);
    if (command === "link") return this.link(inbound.chat, inbound.sender, argument);

    const player = await this.linked(inbound.sender);
    if (player === undefined)
      return inbound.chat.private
        ? reply(
            "Link this account first: ask an admin for a code (`nudge pair <player>`), then send /link <code>.",
          )
        : undefined;
    switch (command) {
      case "unlink":
        return this.unlink(inbound.chat, inbound.sender);
      case "rooms":
        return this.listRooms(inbound.chat, player);
      case "room":
        return this.pickRoom(inbound.chat, player, argument);
      case "approve":
      case "deny":
        return this.decideCommand(inbound.chat, player, argument, command === "approve");
      case "stop": {
        const room = await this.roomFor(inbound.chat, player);
        if (room !== undefined) await this.nudge.abort(room.id, context);
        return;
      }
      case "whisper":
        // In a group, everyone would read it.
        if (!inbound.chat.private) return reply("Send /whisper in a direct chat with me.");
        if (argument === "") return reply("Send /whisper <text>.");
        break;
      case undefined:
        break;
      default:
        return reply(`No command /${command}. ${HELP}`);
    }
    const room = await this.roomFor(inbound.chat, player);
    if (room === undefined) return;
    await this.nudge.submit(
      room.id,
      {
        text: command === "whisper" ? argument : text,
        author: { playerId: player.id, displayName: player.displayName, clientId: player.clientId },
        requestId: `${this.transport.name}:${inbound.chat.id}:${inbound.id}`,
        ...(command === "whisper" ? { private: true } : {}),
      },
      context,
    );
  }

  /**
   * Passes a room's answers and approvals to the chats that talk to it, as the chat's player may
   * see them; a group chat gets only what everyone may see.
   */
  async onRoomEvent(event: RoomEvent): Promise<void> {
    const state = await this.state();
    const privateTo =
      event.type === "answer" ? event.privateTo?.playerId : event.approval.privateTo?.playerId;
    const chats = Object.entries(state.chats).filter(
      ([, chat]) =>
        chat.roomId === event.roomId && (privateTo === undefined || chat.playerId === privateTo),
    );
    for (const [chatId, chat] of chats) {
      const show = (text: string) => this.nudge.showTo(chat.playerId, text);
      try {
        if (event.type === "answer") {
          if (event.status === "stopped" || event.text === "") continue;
          await this.say(
            chatId,
            event.status === "failed"
              ? `${this.nudge.displayName} couldn't answer.`
              : show(event.text),
          );
        } else {
          const id = event.approval.id;
          const summary = show(event.approval.summary);
          if (this.transport.buttons)
            await this.transport.send(chatId, `Waiting for approval (${id}): ${summary}`, [
              { label: "Approve", data: actionData(event.roomId, id, true) },
              { label: "Deny", data: actionData(event.roomId, id, false) },
            ]);
          else
            await this.say(
              chatId,
              `Waiting for approval (${id}): ${summary}\nSend /approve ${id} or /deny ${id}.`,
            );
        }
      } catch (error) {
        this.report(error);
      }
    }
  }

  private async link(chat: Chat, sender: Sender, code: string): Promise<void> {
    // In a group, everyone would see the code before it's used.
    if (!chat.private) return this.say(chat.id, "Send /link in a direct chat with me.");
    if (code === "")
      return this.say(chat.id, "Send /link <code>, with a code from `nudge pair <player>`.");
    const paired = await this.nudge.players.pair(
      code.toUpperCase(),
      { name: this.transport.name, platform: this.transport.name },
      context,
    );
    if (paired === undefined) return this.say(chat.id, "That code is unknown or expired.");
    const room = await this.nudge.rooms.ensurePersonal(paired.player.id, context);
    await this.nudge.harness.commit(async (tx) => {
      const state = await tx.doc(this.doc);
      const old = state.links[sender.id];
      state.links[sender.id] = { playerId: paired.player.id, clientId: paired.clientId };
      state.chats[chat.id] = { roomId: room.id, playerId: paired.player.id };
      return old;
    }, context);
    await this.say(
      chat.id,
      `Linked to ${paired.player.displayName}. This chat talks to "${room.name}"; /rooms lists the others.`,
    );
  }

  private async unlink(chat: Chat, sender: Sender): Promise<void> {
    const link = (await this.state()).links[sender.id];
    if (link === undefined) return;
    await this.nudge.players.revoke(link.clientId, context).catch(() => undefined);
    await this.forget(sender.id, chat.private ? chat.id : undefined);
    await this.say(chat.id, "Unlinked.");
  }

  /** The linked player, or undefined; a link whose token was revoked is dropped here. */
  private async linked(
    sender: Sender,
  ): Promise<(Player & { readonly clientId: string }) | undefined> {
    const link = (await this.state()).links[sender.id];
    if (link === undefined) return undefined;
    const tokens = await this.nudge.players.tokens(link.playerId, context);
    const player = await this.nudge.players.get(link.playerId, context);
    if (player === undefined || !tokens.some((token) => token.clientId === link.clientId)) {
      await this.forget(sender.id);
      return undefined;
    }
    return { ...player, clientId: link.clientId };
  }

  private async forget(senderId: string, chatId?: string): Promise<void> {
    await this.nudge.harness.commit(async (tx) => {
      const state = await tx.doc(this.doc);
      delete state.links[senderId];
      if (chatId !== undefined) delete state.chats[chatId];
    }, context);
  }

  private async listRooms(chat: Chat, player: Player): Promise<void> {
    const current = (await this.state()).chats[chat.id]?.roomId;
    const rooms = await this.nudge.rooms.list(context, player.id);
    await this.say(
      chat.id,
      rooms
        .map((room) => `${room.id} — ${room.name}${room.id === current ? " (this chat)" : ""}`)
        .join("\n"),
    );
  }

  private async pickRoom(chat: Chat, player: Player, roomId: string): Promise<void> {
    const room = roomId === "" ? undefined : await this.nudge.rooms.get(roomId, context);
    if (room === undefined || !canUse(room, player.id))
      return this.say(chat.id, "No such room of yours; /rooms lists them.");
    if (!(await this.nudge.extensionEnabled(room.id, this.extension, context)))
      return this.say(chat.id, `${this.transport.name} is turned off in "${room.name}".`);
    await this.nudge.harness.commit(async (tx) => {
      (await tx.doc(this.doc)).chats[chat.id] = chat.private
        ? { roomId: room.id, playerId: player.id }
        : { roomId: room.id };
    }, context);
    await this.say(chat.id, `This chat talks to "${room.name}" now.`);
  }

  /** The chat's room if the player may use it and the bridge is on there; says why not otherwise. */
  private async roomFor(chat: Chat, player: Player): Promise<Room | undefined> {
    const roomId = (await this.state()).chats[chat.id]?.roomId;
    if (roomId === undefined) {
      await this.say(chat.id, "Pick a room for this chat first: /rooms, then /room <id>.");
      return undefined;
    }
    const room = await this.nudge.rooms.get(roomId, context);
    if (room === undefined || !canUse(room, player.id)) {
      await this.say(chat.id, "You can't use this chat's room; pick another with /room <id>.");
      return undefined;
    }
    if (!(await this.nudge.extensionEnabled(room.id, this.extension, context))) {
      await this.say(chat.id, `${this.transport.name} is turned off in "${room.name}".`);
      return undefined;
    }
    return room;
  }

  private async decideCommand(
    chat: Chat,
    player: Player,
    id: string,
    approve: boolean,
  ): Promise<void> {
    if (id === "") return this.say(chat.id, `Which one? /${approve ? "approve" : "deny"} <id>`);
    const room = await this.roomFor(chat, player);
    if (room === undefined) return;
    const outcome = await this.decide(room.id, id, player, approve);
    await this.say(chat.id, this.nudge.showTo(chat.private ? player.id : undefined, outcome));
  }

  private async action(inbound: Extract<Inbound, { type: "action" }>): Promise<void> {
    const parsed = parseAction(inbound.data);
    const answer = (text: string) => this.transport.answer?.(inbound.id, text);
    if (parsed === undefined) return void (await answer("Unknown button"));
    const player = await this.linked(inbound.sender);
    const room = await this.nudge.rooms.get(parsed.roomId, context);
    if (player === undefined || room === undefined || !canUse(room, player.id))
      return void (await answer("You can't decide this one"));
    const viewer = inbound.chat.private ? player.id : undefined;
    const outcome = this.nudge.showTo(
      viewer,
      await this.decide(room.id, parsed.id, player, parsed.approve),
    );
    await answer(outcome.slice(0, 190));
    const approval = await this.nudge.approvals.get(room.id, parsed.id, context);
    if (inbound.messageId !== undefined && approval !== undefined)
      await this.transport
        .edit?.(
          inbound.chat.id,
          inbound.messageId,
          `Approval (${approval.id}): ${this.nudge.showTo(viewer, approval.summary)}\n${outcome}`,
        )
        .catch(this.report);
  }

  /** Decides an approval for the player, and says how it went. */
  private async decide(
    roomId: string,
    id: string,
    player: Player,
    approve: boolean,
  ): Promise<string> {
    const by = { playerId: player.id, displayName: player.displayName };
    try {
      const approval = await this.nudge.approvals.decide(roomId, id, { approve, by }, context);
      if (approval.status === "denied") return `Denied by ${player.displayName}.`;
      return `Approved by ${player.displayName}${approval.result === undefined ? "" : `: ${approval.result}`}`;
    } catch (error) {
      if (error instanceof ApprovalNotFound) return `No approval ${id} here.`;
      if (error instanceof AlreadyDecided) return `${id} is already decided.`;
      if (error instanceof AdminOnly) return `Only an admin may decide ${id}.`;
      throw error;
    }
  }

  /** Sends text in parts no longer than the service takes, cut at line breaks where it can. */
  private async say(chatId: string, text: string): Promise<void> {
    for (const part of split(text, this.transport.maxLength))
      await this.transport.send(chatId, part);
  }
}

export function split(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

function actionData(roomId: string, id: string, approve: boolean): string {
  return `ap|${roomId}|${id}|${approve ? "y" : "n"}`;
}

function parseAction(
  data: string,
): { readonly roomId: string; readonly id: string; readonly approve: boolean } | undefined {
  const match = /^ap\|([^|]+)\|([^|]+)\|([yn])$/.exec(data);
  return match === null
    ? undefined
    : { roomId: match[1]!, id: match[2]!, approve: match[3] === "y" };
}

/** `${NAME}` replaced from `env`, so tokens stay out of nudge.json; throws naming a missing one. */
export function fillVariables(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  extension: string,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const filled = env[name];
    if (filled === undefined || filled === "") throw new Error(`${extension}: $${name} is not set`);
    return filled;
  });
}

/** Settles once the assistant is open, or once `signal` aborts; a bridge's loop starts after. */
export async function untilOpen(
  host: Pick<ExtensionHost<unknown>, "assistant">,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      host.assistant();
      return;
    } catch {
      await sleep(200, signal);
    }
  }
}

export type PollOptions = {
  readonly signal: AbortSignal;
  readonly report: (error: unknown) => void;
  /** Milliseconds to wait after a failure; each further one in a row doubles it. Default 5 s. */
  readonly retryMs?: number;
  /** Longest wait between tries. Default 5 min. */
  readonly maxRetryMs?: number;
  /** At least this long after `error`, such as a minute after a token the service refuses. */
  readonly atLeast?: (error: unknown) => number;
};

/**
 * Runs `step` again and again until `signal` aborts. A step that throws is reported and waited
 * out, longer after each failure in a row, so a service that is down is neither hammered nor
 * able to stop the bridge, and nothing it throws reaches the host as an unhandled rejection.
 */
export async function keepPolling(step: () => Promise<void>, options: PollOptions): Promise<void> {
  const { signal, retryMs = 5_000, maxRetryMs = 300_000 } = options;
  let failures = 0;
  while (!signal.aborted) {
    try {
      await step();
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      try {
        options.report(error);
      } catch {
        // A report that throws must not end the loop either.
      }
      const backoff = Math.min(retryMs * 2 ** failures, maxRetryMs);
      failures++;
      await sleep(Math.max(backoff, options.atLeast?.(error) ?? 0), signal);
    }
  }
}

/** Waits `ms`, or less if `signal` aborts first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
