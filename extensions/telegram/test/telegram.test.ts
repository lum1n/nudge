import {
  BACKGROUND_CONTEXT,
  createNudge,
  defineNudgeExtension,
  type ModelContext,
  type Nudge,
  requestApproval,
} from "@nudge/core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@nudge/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { split } from "@nudge/bridge";
import { telegramExtension, type Update } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

type Sent = { chat_id: string; text: string; reply_markup?: unknown; message_id: number };

/** The Bot API as the bridge uses it, in memory. */
class FakeTelegram {
  private queue: Update[] = [];
  private nextUpdate = 1;
  private nextMessage = 100;
  private wake: (() => void) | undefined;
  readonly sent: Sent[] = [];
  readonly answers: { callback_query_id: string; text: string }[] = [];
  readonly edits: { chat_id: string; message_id: number; text: string }[] = [];
  tokenSeen: string | undefined;

  message(
    chat: { id: number; type: string },
    from: { id: number; first_name: string },
    text: string,
  ) {
    this.add({ message: { message_id: this.nextMessage++, chat, from, text } });
  }

  press(sent: Sent, from: { id: number; first_name: string }, data: string) {
    this.add({
      callback_query: {
        id: `q${this.nextUpdate}`,
        from,
        data,
        message: {
          message_id: sent.message_id,
          chat: { id: Number(sent.chat_id), type: "private" },
        },
      },
    });
  }

  private add(update: Omit<Update, "update_id">) {
    this.queue.push({ update_id: this.nextUpdate++, ...update });
    this.wake?.();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const [, token, method] = /\/bot([^/]+)\/(\w+)$/.exec(String(input))!;
    this.tokenSeen = token;
    const body = JSON.parse(String(init!.body)) as Record<string, any>;
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    switch (method) {
      case "getUpdates": {
        this.queue = this.queue.filter((u) => u.update_id >= body.offset);
        if (this.queue.length === 0)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 50);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
            init!.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        this.wake = undefined;
        return ok([...this.queue]);
      }
      case "sendMessage": {
        const sent = {
          ...body,
          chat_id: String(body.chat_id),
          message_id: this.nextMessage++,
        } as Sent;
        this.sent.push(sent);
        return ok({ message_id: sent.message_id });
      }
      case "answerCallbackQuery":
        this.answers.push(body as never);
        return ok(true);
      case "editMessageText":
        this.edits.push({ ...body, chat_id: String(body.chat_id) } as never);
        return ok(true);
      case "setMyCommands":
        return ok(true);
      default:
        return new Response(JSON.stringify({ ok: false, description: `No ${method}` }));
    }
  };

  /** Texts sent to `chat` so far. */
  to(chat: number): string[] {
    return this.sent.filter((s) => s.chat_id === String(chat)).map((s) => s.text);
  }
}

/** An extension whose `do` approvals succeed, so the test can file one. */
const doer = defineNudgeExtension({
  name: "doer",
  version: "1",
  setup: () => ({ approvals: { do: async () => ({ text: "Done it." }) } }),
});

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("telegram bridge", () => {
  let telegram: FakeTelegram;
  let nudge: Nudge;
  const ann = { id: 11, first_name: "Ann" };
  const bo = { id: 22, first_name: "Bo" };
  const annChat = { id: 11, type: "private" };
  const group = { id: -500, type: "group" };

  beforeEach(async () => {
    process.env.TEST_TELEGRAM_TOKEN = "123:secret";
    telegram = new FakeTelegram();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const lastUser = (request: ModelContext) => {
      const message = request.messages.findLast((m) => m.role === "user");
      return typeof message?.content === "string"
        ? message.content
        : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
    };
    faux.setResponses(
      Array.from(
        { length: 20 },
        () => (request: ModelContext) =>
          fauxAssistantMessage([fauxText(`Answer to ${lastUser(request)}`)]),
      ),
    );
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          doer,
          {
            extension: telegramExtension({
              fetch: telegram.fetch,
              report: (e) => console.error(e),
            }),
            settings: { token: "${TEST_TELEGRAM_TOKEN}", pollSeconds: 1 },
          },
        ],
      },
      context,
    );
    await nudge.players.invite("Ann", context);
    await nudge.players.invite("Bo", context);
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
  });

  afterEach(async () => {
    await nudge.close(context);
    delete process.env.TEST_TELEGRAM_TOKEN;
  });

  it("links with a pairing code, then carries messages in and answers out", async () => {
    telegram.message(annChat, ann, "Hello?");
    await until(() => telegram.to(11).length === 1);
    expect(telegram.to(11)[0]).toMatch(/^Link this account first/);
    expect(telegram.tokenSeen).toBe("123:secret");

    const { code } = await nudge.players.pairingCode("ann", context);
    telegram.message(annChat, ann, `/link ${code.toLowerCase()}`);
    await until(() => telegram.to(11).length === 2);
    expect(telegram.to(11)[1]).toBe(
      `Linked to Ann. This chat talks to "Ann's room"; /rooms lists the others.`,
    );
    // The link is a token like any client's, so it shows up, and can be revoked, with the others.
    expect((await nudge.players.tokens("ann", context)).map((t) => t.client?.name)).toContain(
      "telegram",
    );

    telegram.message(annChat, ann, "What's for dinner?");
    await until(() => telegram.to(11).length === 3);
    expect(telegram.to(11)[2]).toMatch(/^Answer to Ann \(\d\d:\d\d\): What's for dinner\?$/);
    const room = await nudge.conversation("personal-ann", context);
    const entries = (await room.entries({ order: "ascending" }, 50, undefined, context)).items;
    expect(entries.find((e) => e.kind === "nudge.message")?.data).toMatchObject({
      text: "What's for dinner?",
      playerId: "ann",
    });
  });

  it("lets a group talk to a shared room, approve from a button, and stops at a revoked link", async () => {
    const { code } = await nudge.players.pairingCode("ann", context);
    telegram.message(annChat, ann, `/link ${code}`);
    await until(() => telegram.to(11).length === 1);

    // Bo isn't linked: in a group, the bot says nothing to him.
    telegram.message(group, bo, "Hi all");
    telegram.message(group, ann, "/room trip");
    await until(() => telegram.to(-500).length === 1);
    expect(telegram.to(-500)).toEqual([`This chat talks to "Trip" now.`]);
    telegram.message(group, ann, "/rooms");
    await until(() => telegram.to(-500).length === 2);
    expect(telegram.to(-500)[1]).toContain("trip — Trip (this chat)");

    await nudge.harness.commit(
      (tx) =>
        requestApproval(
          tx,
          "trip",
          { extension: "doer", kind: "do", summary: "Book the cabin", payload: null },
          Date.now(),
        ),
      context,
    );
    await until(() => telegram.to(-500).length === 3);
    const prompt = telegram.sent.at(-1)!;
    expect(prompt.text).toBe("Waiting for approval (a1): Book the cabin");
    expect(prompt.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: "ap|trip|a1|y" },
          { text: "Deny", callback_data: "ap|trip|a1|n" },
        ],
      ],
    });
    // Bo can't press it; Ann can.
    telegram.press(prompt, bo, "ap|trip|a1|y");
    await until(() => telegram.answers.length === 1);
    expect(telegram.answers[0]!.text).toBe("You can't decide this one");
    telegram.press(prompt, ann, "ap|trip|a1|y");
    await until(() => telegram.answers.length === 2);
    expect(telegram.answers[1]!.text).toBe("Approved by Ann: Done it.");
    expect(telegram.edits[0]).toMatchObject({
      message_id: prompt.message_id,
      text: "Approval (a1): Book the cabin\nApproved by Ann: Done it.",
    });
    expect((await nudge.approvals.get("trip", "a1", context))?.status).toBe("done");

    const link = (await nudge.players.tokens("ann", context)).find(
      (t) => t.client?.name === "telegram",
    );
    await nudge.players.revoke(link!.clientId, context);
    telegram.message(annChat, ann, "Still there?");
    await until(() => telegram.to(11).length === 2);
    expect(telegram.to(11)[1]).toMatch(/^Link this account first/);
  });

  it("splits long text at line breaks", () => {
    expect(split("aaaa\nbbbb\ncc", 6)).toEqual(["aaaa", "bbbb", "cc"]);
    expect(split("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });
});
