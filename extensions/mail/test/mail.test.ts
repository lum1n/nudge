import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  htmlToText,
  ImapSmtpBackend,
  type MailAccount,
  type MailBackend,
  type MailMessage,
  type MailQuery,
  type OutgoingMail,
  mailExtension,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };

/** An inbox in memory, and what was sent. */
class FakeMail implements MailBackend {
  readonly sent: { account: string; mail: OutgoingMail }[] = [];
  readonly queries: MailQuery[] = [];
  readonly inbox: MailMessage[] = [
    {
      uid: 41,
      date: new Date("2026-10-12T08:00:00Z"),
      from: "Skolen <post@skole.example>",
      to: "family@home.example",
      subject: "Foreldremøte torsdag",
      unread: true,
      text: "Hei! Foreldremøte torsdag kl 18 i aulaen. Ring 912 34 567 ved spørsmål.",
      messageId: "<m41@skole.example>",
      references: [],
    },
  ];

  async search(_account: MailAccount, query: MailQuery) {
    this.queries.push(query);
    return this.inbox;
  }

  async read(_account: MailAccount, uid: number) {
    return this.inbox.find((mail) => mail.uid === uid);
  }

  async send(account: MailAccount, mail: OutgoingMail) {
    this.sent.push({ account: account.id, mail });
    return { messageId: "<sent1@home.example>" };
  }
}

function lastUser(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "user");
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("mail", () => {
  let nudge: Nudge;
  let mail: FakeMail;
  let requests: ModelContext[];

  beforeEach(async () => {
    process.env.TEST_MAIL_PASSWORD = "hunter2";
    mail = new FakeMail();
    requests = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      requests.push(request);
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([
          fauxText(last.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
        ]);
      const text = lastUser(request);
      if (/what did the school send/i.test(text))
        return fauxAssistantMessage([fauxToolCall("mail_search", { from: "skole" })], {
          stopReason: "toolUse",
        });
      if (/read it/i.test(text))
        return fauxAssistantMessage([fauxToolCall("mail_read", { uid: 41 })], {
          stopReason: "toolUse",
        });
      if (/answer them/i.test(text))
        return fauxAssistantMessage(
          [
            fauxToolCall("mail_send", {
              to: ["post@skole.example"],
              body: "Vi kommer!",
              reply_to_uid: 41,
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 50 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: mailExtension({ backend: mail }),
            settings: {
              accounts: [
                {
                  id: "family",
                  from: "Familien <family@home.example>",
                  imap: {
                    host: "imap.home.example",
                    user: "family",
                    password: "${TEST_MAIL_PASSWORD}",
                  },
                  rooms: [LOBBY],
                },
              ],
            },
          },
        ],
      },
      context,
    );
  });

  afterEach(async () => {
    await nudge.close(context);
    delete process.env.TEST_MAIL_PASSWORD;
  });

  const say = async (text: string) => {
    const settled = await (await nudge.submit(LOBBY, { text, author: by }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };
  const toolOutput = () => {
    const last = requests.at(-1)!.messages.findLast((m) => m.role === "toolResult");
    return last?.role === "toolResult"
      ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : "";
  };

  it("searches and reads the inbox, with personal values kept from the model", async () => {
    await say("What did the school send?");
    expect(mail.queries[0]).toMatchObject({
      from: "skole",
      sinceDays: 14,
      unreadOnly: false,
      limit: 20,
    });
    const listing = toolOutput();
    expect(listing).toContain("#41");
    expect(listing).toContain("Foreldremøte torsdag");
    expect(listing).toContain("[unread]");
    // The sender's address went to the model as a placeholder.
    expect(listing).not.toContain("post@skole.example");
    expect(listing).toMatch(/⟦EMAIL\d+⟧/);

    await say("Read it");
    const body = toolOutput();
    expect(body).toContain("Foreldremøte torsdag kl 18 i aulaen");
    expect(body).not.toContain("912 34 567");
    // The section tells the model which accounts there are.
    const system = JSON.stringify(requests.at(-1)!.messages.filter((m) => m.role === "system"));
    expect(system).toContain("mail_search");
  });

  it("sends a reply in its thread only once someone approves", async () => {
    await say("Answer them that we're coming");
    expect(mail.sent).toEqual([]);
    const [approval] = await nudge.approvals.list(LOBBY, context);
    expect(approval).toMatchObject({ extension: "mail", kind: "send", status: "pending" });
    expect(approval!.summary).toContain('to post@skole.example: "Re: Foreldremøte torsdag"');

    const done = await nudge.approvals.decide(LOBBY, approval!.id, { approve: true, by }, context);
    expect(done.status).toBe("done");
    expect(mail.sent).toEqual([
      {
        account: "family",
        mail: {
          account: "family",
          to: ["post@skole.example"],
          subject: "Re: Foreldremøte torsdag",
          text: "Vi kommer!",
          inReplyTo: "<m41@skole.example>",
          references: ["<m41@skole.example>"],
        },
      },
    ]);
  });

  it("gives rooms not listed no account", async () => {
    await nudge.players.invite("Ann", context);
    const room = await nudge.rooms.ensurePersonal("ann", context);
    const settled = await (
      await nudge.submit(
        room.id,
        { text: "What did the school send?", author: { playerId: "ann", displayName: "Ann" } },
        context,
      )
    ).wait(context);
    expect(settled.status).toBe("done");
    expect(toolOutput()).toBe("No mail account is set up for this conversation.");
    expect(mail.queries).toEqual([]);
  });
});

describe("the SMTP side, against a real SMTP server", () => {
  it("sends with the account's login, threaded", async () => {
    const received: string[] = [];
    const logins: string[] = [];
    const server = new SMTPServer({
      secure: false,
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      onAuth(auth, _session, callback) {
        logins.push(`${auth.username}:${auth.password}`);
        callback(null, { user: auth.username });
      },
      onData(stream, _session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          received.push(Buffer.concat(chunks).toString());
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.server.address() as AddressInfo).port;
    const account: MailAccount = {
      id: "family",
      from: "Familien <family@home.example>",
      rooms: ["*"],
      imap: { host: "127.0.0.1", port: 1, secure: false, user: "family", password: "pw" },
      smtp: { host: "127.0.0.1", port, secure: false, user: "family", password: "pw" },
    };
    try {
      const sent = await new ImapSmtpBackend().send(account, {
        to: ["post@skole.example"],
        subject: "Re: Foreldremøte",
        text: "Vi kommer!",
        inReplyTo: "<m41@skole.example>",
        references: ["<m41@skole.example>"],
      });
      expect(sent.messageId).toMatch(/^<.+>$/);
      expect(logins).toEqual(["family:pw"]);
      const parsed = await simpleParser(received[0]!);
      expect(parsed.from?.value[0]).toMatchObject({
        name: "Familien",
        address: "family@home.example",
      });
      expect(parsed.subject).toBe("Re: Foreldremøte");
      expect(parsed.text?.trim()).toBe("Vi kommer!");
      expect(parsed.inReplyTo).toBe("<m41@skole.example>");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("turns HTML mail into text", () => {
    expect(htmlToText("<p>Hei&nbsp;der</p><br><style>x{}</style><b>Møte</b> &amp; mat")).toBe(
      "Hei der\n\nMøte & mat",
    );
  });
});
