import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";

/** One mail account as the extension uses it, its passwords filled in. */
export type MailAccount = {
  readonly id: string;
  /** Who mail is sent as, such as `Family <family@example.org>`. */
  readonly from: string;
  readonly imap: Server;
  readonly smtp: Server;
  /** Room ids that may use it; `*` for every room. */
  readonly rooms: readonly string[];
};

export type Server = {
  readonly host: string;
  readonly port: number;
  /** TLS from the start; false starts plain and upgrades with STARTTLS. */
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
};

export type MailQuery = {
  readonly text?: string;
  readonly from?: string;
  readonly sinceDays: number;
  readonly unreadOnly: boolean;
  readonly limit: number;
};

export type MailSummary = {
  readonly uid: number;
  readonly date: Date;
  readonly from: string;
  readonly subject: string;
  readonly unread: boolean;
};

export type MailMessage = MailSummary & {
  readonly to: string;
  readonly cc?: string;
  readonly text: string;
  readonly messageId?: string;
  readonly references: readonly string[];
};

export type OutgoingMail = {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
};

/** What the tools need from a mail server; tests put a fake in its place. */
export interface MailBackend {
  /** The newest matching messages in the inbox, newest first. */
  search(account: MailAccount, query: MailQuery): Promise<MailSummary[]>;
  /** One inbox message by its UID; undefined when it is gone. Reading doesn't mark it read. */
  read(account: MailAccount, uid: number): Promise<MailMessage | undefined>;
  send(account: MailAccount, mail: OutgoingMail): Promise<{ readonly messageId: string }>;
}

const DAY = 86_400_000;

/** IMAP through ImapFlow, a connection per call; SMTP through Nodemailer. */
export class ImapSmtpBackend implements MailBackend {
  async search(account: MailAccount, query: MailQuery): Promise<MailSummary[]> {
    return this.inbox(account, async (client) => {
      const criteria: SearchObject = { since: new Date(Date.now() - query.sinceDays * DAY) };
      if (query.text !== undefined) criteria.text = query.text;
      if (query.from !== undefined) criteria.from = query.from;
      if (query.unreadOnly) criteria.seen = false;
      const uids = (await client.search(criteria, { uid: true })) || [];
      const newest = uids.sort((a, b) => b - a).slice(0, query.limit);
      if (newest.length === 0) return [];
      const found: MailSummary[] = [];
      for await (const message of client.fetch(
        newest,
        { uid: true, envelope: true, flags: true, internalDate: true },
        { uid: true },
      ))
        found.push({
          uid: message.uid,
          date: new Date(message.envelope?.date ?? message.internalDate ?? 0),
          from: addresses(message.envelope?.from),
          subject: message.envelope?.subject ?? "",
          unread: !message.flags?.has("\\Seen"),
        });
      return found.sort((a, b) => b.uid - a.uid);
    });
  }

  async read(account: MailAccount, uid: number): Promise<MailMessage | undefined> {
    return this.inbox(account, async (client) => {
      const message = await client.fetchOne(
        String(uid),
        { uid: true, source: true, flags: true },
        { uid: true },
      );
      if (!message || message.source === undefined) return undefined;
      const parsed = await simpleParser(message.source);
      const text = parsed.text ?? htmlToText(typeof parsed.html === "string" ? parsed.html : "");
      const references = parsed.references;
      return {
        uid,
        date: parsed.date ?? new Date(0),
        from: parsed.from?.text ?? "",
        to: (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
          .map((to) => to.text)
          .join(", "),
        ...(parsed.cc === undefined
          ? {}
          : {
              cc: (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
                .map((cc) => cc.text)
                .join(", "),
            }),
        subject: parsed.subject ?? "",
        unread: !message.flags?.has("\\Seen"),
        text,
        ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
        references:
          references === undefined ? [] : Array.isArray(references) ? references : [references],
      };
    });
  }

  async send(account: MailAccount, mail: OutgoingMail): Promise<{ messageId: string }> {
    const transport = createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.smtp.user, pass: account.smtp.password },
    });
    try {
      const sent = await transport.sendMail({
        from: account.from,
        to: [...mail.to],
        ...(mail.cc === undefined ? {} : { cc: [...mail.cc] }),
        subject: mail.subject,
        text: mail.text,
        ...(mail.inReplyTo === undefined ? {} : { inReplyTo: mail.inReplyTo }),
        ...(mail.references === undefined ? {} : { references: [...mail.references] }),
      });
      return { messageId: sent.messageId };
    } finally {
      transport.close();
    }
  }

  private async inbox<T>(account: MailAccount, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.imap.user, pass: account.imap.password },
      logger: false,
    });
    await client.connect();
    try {
      // Read-only, so reading never marks anything read.
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        return await work(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

function addresses(list: readonly { name?: string; address?: string }[] | undefined): string {
  return (list ?? [])
    .map(({ name, address }) => (name ? `${name} <${address ?? ""}>` : (address ?? "")))
    .join(", ");
}

/** Text from HTML mail with no text part: tags out, block ends as line breaks, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
