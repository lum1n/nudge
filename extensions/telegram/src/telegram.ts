import type { Button, Inbound, Transport } from "@nudge/bridge";

/** The parts of the Bot API's `Update` the bridge reads. */
export type Update = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: User;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: User;
    data?: string;
    message?: { message_id: number; chat: { id: number; type: string } };
  };
};

type User = { id: number; first_name: string; last_name?: string; username?: string };

export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
  }
}

/** Telegram's limit is 4096 characters; leave room. */
const MAX_LENGTH = 4000;

/** The few Bot API methods the bridge uses. Errors never carry the token. */
export class TelegramApi implements Transport {
  readonly name = "telegram";
  readonly maxLength = MAX_LENGTH;
  readonly buttons = true;

  constructor(
    private readonly token: string,
    private readonly base = "https://api.telegram.org",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramError(`Telegram ${method}: ${(error as Error).message}`, undefined);
    }
    const reply = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (reply.ok !== true)
      throw new TelegramError(
        `Telegram ${method}: ${reply.description ?? `HTTP ${response.status}`}`,
        reply.error_code ?? response.status,
      );
    return reply.result as T;
  }

  /** Waits up to `timeout` seconds for updates after `offset`. */
  getUpdates(offset: number, timeout: number, signal: AbortSignal): Promise<Update[]> {
    return this.call(
      "getUpdates",
      { offset, timeout, allowed_updates: ["message", "callback_query"] },
      AbortSignal.any([signal, AbortSignal.timeout((timeout + 15) * 1000)]),
    );
  }

  async send(chatId: string, text: string, buttons?: readonly Button[]): Promise<string> {
    const message = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(buttons === undefined
        ? {}
        : {
            reply_markup: {
              inline_keyboard: [
                buttons.map(({ label, data }) => ({ text: label, callback_data: data })),
              ],
            },
          }),
    });
    return String(message.message_id);
  }

  async answer(actionId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: actionId, text });
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: text.slice(0, MAX_LENGTH),
    });
  }

  /** Shows the bridge's commands in Telegram's menu. */
  async setCommands(commands: readonly { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }
}

/** What the bridge reads from an update; undefined for kinds it ignores. */
export function toInbound(update: Update): Inbound | undefined {
  const { message, callback_query: query } = update;
  if (message?.text !== undefined && message.from !== undefined)
    return {
      type: "message",
      chat: { id: String(message.chat.id), private: message.chat.type === "private" },
      sender: { id: String(message.from.id), name: nameOf(message.from) },
      text: message.text,
      id: String(message.message_id),
    };
  if (query?.data !== undefined && query.message !== undefined)
    return {
      type: "action",
      chat: { id: String(query.message.chat.id), private: query.message.chat.type === "private" },
      sender: { id: String(query.from.id), name: nameOf(query.from) },
      data: query.data,
      id: query.id,
      messageId: String(query.message.message_id),
    };
  return undefined;
}

function nameOf(user: User): string {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    (user.username ?? String(user.id))
  );
}
