import { fillVariables } from "@nudge/bridge";
import {
  actingFor,
  AttachmentNotFound,
  AttachmentRemoved,
  ATTACHMENTS_PER_MESSAGE,
  currentTurn,
  defineNudgeExtension,
  defineTool,
  formatTime,
  readsOnly,
  returnsUntrusted,
  requestApproval,
  roomOf,
  roomsSetting,
  section,
  Type,
} from "@nudge/core";
import {
  ImapSmtpBackend,
  type MailAccount,
  type MailAttachment,
  type MailBackend,
  type MailSummary,
  type OutgoingMail,
} from "./backend.ts";

const VERSION = "0.1.0";
/** Characters of a message body the model gets. */
const MAX_BODY = 15_000;
/**
 * Most bytes of attachments one mail sends: many mail servers refuse messages over 25 MB, and
 * base64 makes files a third bigger.
 */
const MAX_ATTACHED = 18 * 1024 * 1024;

const serverSettings = (options: { title?: string; description?: string } = {}) =>
  Type.Object(
    {
      host: Type.String({
        minLength: 1,
        description: "The mail server's host name, such as imap.example.org.",
      }),
      port: Type.Optional(
        Type.Number({
          description: "The server's port; 993 for IMAP and 465 for SMTP when left out.",
        }),
      ),
      secure: Type.Optional(
        Type.Boolean({
          description:
            "Use TLS from the start instead of upgrading with STARTTLS; by default on for IMAP, and for SMTP on port 465.",
        }),
      ),
      user: Type.Optional(
        Type.String({
          description:
            "The user name to log in with; ${NAME} takes it from an environment variable.",
        }),
      ),
      /** `${NAME}` takes it from the host's environment, so it stays out of nudge.json. */
      password: Type.Optional(
        Type.String({
          description:
            "The password to log in with; write ${NAME} to take it from an environment variable instead.",
        }),
      ),
    },
    options,
  );

const AccountSettings = Type.Object({
  id: Type.String({
    pattern: "^[a-z0-9][a-z0-9-]*$",
    description: "A short name for the account, in lowercase letters, digits and dashes.",
  }),
  from: Type.String({
    minLength: 3,
    description:
      "The sender address on mail the assistant sends, such as Robin <robin@example.org>.",
  }),
  imap: Type.Intersect(
    [
      serverSettings(),
      Type.Object({
        user: Type.String({
          description:
            "The user name to log in with; ${NAME} takes it from an environment variable.",
        }),
        password: Type.String({
          description:
            "The password to log in with; write ${NAME} to take it from an environment variable instead.",
        }),
      }),
    ],
    { title: "IMAP", description: "The server mail is searched and read on." },
  ),
  /** Default: the IMAP host's name with `imap.` turned into `smtp.`, port 465, the IMAP login. */
  smtp: Type.Optional(
    serverSettings({
      title: "SMTP",
      description:
        "The server mail is sent through; by default the IMAP host with imap. turned into smtp., port 465 and the IMAP login.",
    }),
  ),
  /** Room ids that may use the account; `*` for every room. */
  rooms: roomsSetting({ title: "Rooms", description: "The rooms that may use this account." }),
});

const Settings = Type.Object({
  accounts: Type.Array(AccountSettings, {
    default: [],
    description: "The mail accounts the assistant can search, read and send from.",
  }),
});

type SendPayload = Omit<OutgoingMail, "attachments"> & {
  readonly account: string;
  /**
   * Attachments of the room's messages (ADR 24), read when it is sent, as whoever asked may see
   * them; names with placeholders, which the approval puts back.
   */
  readonly attachments?: readonly { readonly id: string; readonly name: string }[];
};

export type MailOptions = {
  /** The mail servers; tests pass a fake. */
  readonly backend?: MailBackend;
};

/** The mail extension with its backend chosen; the default export uses IMAP and SMTP. */
export function mailExtension(options: MailOptions = {}) {
  return defineNudgeExtension({
    name: "mail",
    version: VERSION,
    apiVersion: "1.0",
    description:
      "Search and read mail over IMAP; send it over SMTP once someone in the room approves.",
    settings: Settings,
    setup: (host) => {
      const backend = options.backend ?? new ImapSmtpBackend();
      const accounts: MailAccount[] = host.settings.accounts.map((account) => {
        const fill = (value: string) => fillVariables(value, process.env, "mail");
        const imap = {
          host: account.imap.host,
          port: account.imap.port ?? 993,
          secure: account.imap.secure ?? true,
          user: fill(account.imap.user),
          password: fill(account.imap.password),
        };
        return {
          id: account.id,
          from: account.from,
          rooms: account.rooms,
          imap,
          smtp: {
            host: account.smtp?.host ?? imap.host.replace(/^imap\./, "smtp."),
            port: account.smtp?.port ?? 465,
            secure: account.smtp?.secure ?? (account.smtp?.port ?? 465) === 465,
            user: account.smtp?.user === undefined ? imap.user : fill(account.smtp.user),
            password:
              account.smtp?.password === undefined ? imap.password : fill(account.smtp.password),
          },
        };
      });
      const usableIn = (roomId: string) =>
        accounts.filter((account) => account.rooms.includes("*") || account.rooms.includes(roomId));
      const text = (value: string, isError = false) => ({
        output: [{ type: "text" as const, text: value }],
        ...(isError ? { isError } : {}),
      });
      const pick = (roomId: string, id: string | undefined): MailAccount | string => {
        const usable = usableIn(roomId);
        if (usable.length === 0) return "No mail account is set up for this conversation.";
        if (id === undefined) return usable[0]!;
        return (
          usable.find((account) => account.id === id) ??
          `No mail account "${id}" here; there is ${usable.map((a) => a.id).join(", ")}.`
        );
      };
      const line = (mail: MailSummary) =>
        `#${mail.uid}  ${formatTime(mail.date.getTime(), host.timeZone)}  ${mail.from} — ${mail.subject}` +
        (mail.unread ? "  [unread]" : "");
      const nudge = () => host.assistant();
      /** What `find` gives, or why the attachment `id` can't be sent. */
      const reachable = async <T extends object>(
        id: string,
        find: () => Promise<T>,
      ): Promise<T | string> => {
        try {
          return await find();
        } catch (error) {
          if (error instanceof AttachmentNotFound) return `No attachment ${id} here.`;
          if (error instanceof AttachmentRemoved) return `Attachment ${id} was removed.`;
          throw error;
        }
      };
      const accountParameter = Type.Optional(
        Type.String({ description: "Account id; default the first one here." }),
      );

      const search = defineTool({
        name: "mail_search",
        description:
          "Search the inbox of a mail account this conversation may use, newest first. Gives each " +
          "message's #uid for mail_read.",
        parameters: Type.Object({
          account: accountParameter,
          text: Type.Optional(Type.String({ description: "Words in the subject or body." })),
          from: Type.Optional(
            Type.String({ description: "Part of the sender's name or address." }),
          ),
          since_days: Type.Optional(Type.Number({ description: "How far back; default 14." })),
          unread_only: Type.Optional(Type.Boolean()),
          limit: Type.Optional(
            Type.Number({ description: "At most this many; default 20, up to 50." }),
          ),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const account = pick(room.id, args.account);
          if (typeof account === "string") return text(account, true);
          const found = await backend.search(account, {
            ...(args.text === undefined ? {} : { text: args.text }),
            ...(args.from === undefined ? {} : { from: args.from }),
            sinceDays: Math.max(1, args.since_days ?? 14),
            unreadOnly: args.unread_only ?? false,
            limit: Math.min(Math.max(1, args.limit ?? 20), 50),
          });
          return text(found.length === 0 ? "No messages match." : found.map(line).join("\n"));
        },
      });

      const read = defineTool({
        name: "mail_read",
        description: "Read one message from mail_search by its #uid. Doesn't mark it read.",
        parameters: Type.Object({ account: accountParameter, uid: Type.Number() }),
        replay: "safe",
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const account = pick(room.id, args.account);
          if (typeof account === "string") return text(account, true);
          const mail = await backend.read(account, args.uid);
          if (mail === undefined)
            return text(`No message #${args.uid} in ${account.id}'s inbox.`, true);
          const body =
            mail.text.length > MAX_BODY ? `${mail.text.slice(0, MAX_BODY)}\n…(cut)` : mail.text;
          return text(
            [
              `From: ${mail.from}`,
              `To: ${mail.to}`,
              ...(mail.cc === undefined ? [] : [`Cc: ${mail.cc}`]),
              `Date: ${formatTime(mail.date.getTime(), host.timeZone)}`,
              `Subject: ${mail.subject}`,
              "",
              body,
            ].join("\n"),
          );
        },
      });

      const send = defineTool({
        name: "mail_send",
        description:
          "Send an e-mail from an account this conversation may use. It waits for someone in the " +
          "room to approve it; say so. With reply_to_uid it answers that message in its thread. " +
          "attachments sends files people attached to messages here, by their ids (such as a3, " +
          "from the messages' [attachment …] lines).",
        parameters: Type.Object({
          account: accountParameter,
          to: Type.Array(Type.String(), { minItems: 1 }),
          cc: Type.Optional(Type.Array(Type.String())),
          subject: Type.Optional(
            Type.String({ description: "Default for a reply: Re: and theirs." }),
          ),
          body: Type.String(),
          reply_to_uid: Type.Optional(Type.Number()),
          attachments: Type.Optional(
            Type.Array(Type.String(), {
              maxItems: ATTACHMENTS_PER_MESSAGE,
              description: "Ids of attachments to send with it, such as a3.",
            }),
          ),
        }),
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const account = pick(room.id, args.account);
          if (typeof account === "string") return text(account, true);
          let thread: Pick<OutgoingMail, "inReplyTo" | "references"> = {};
          let subject = args.subject;
          if (args.reply_to_uid !== undefined) {
            const original = await backend.read(account, args.reply_to_uid);
            if (original === undefined)
              return text(`No message #${args.reply_to_uid} to reply to.`, true);
            subject ??= /^re:/i.test(original.subject)
              ? original.subject
              : `Re: ${original.subject}`;
            if (original.messageId !== undefined)
              thread = {
                inReplyTo: original.messageId,
                references: [...original.references, original.messageId],
              };
          }
          if (subject === undefined || subject.trim() === "") return text("Give a subject.", true);
          // Only what the person this turn acts for may see (ADR 24).
          const viewer = actingFor(currentTurn())?.playerId;
          const attached: { id: string; name: string; size: number }[] = [];
          for (const id of new Set(args.attachments ?? [])) {
            const found = await reachable(id, () =>
              nudge().attachments.get(room.id, id, viewer, context),
            );
            if (typeof found === "string") return text(found, true);
            attached.push({ id, name: found.name, size: found.size });
          }
          if (attached.reduce((sum, { size }) => sum + size, 0) > MAX_ATTACHED)
            return text(
              `Those attachments come to more than ${MAX_ATTACHED / 1024 / 1024} MB, more than mail takes.`,
              true,
            );
          const payload: SendPayload = {
            account: account.id,
            to: args.to,
            ...(args.cc === undefined ? {} : { cc: args.cc }),
            subject,
            text: args.body,
            ...thread,
            ...(attached.length === 0
              ? {}
              : { attachments: attached.map(({ id, name }) => ({ id, name })) }),
          };
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                {
                  extension: "mail",
                  kind: "send",
                  summary:
                    `Send an e-mail from ${account.from} to ${[...args.to, ...(args.cc ?? [])].join(", ")}: ` +
                    `"${subject}"\n\n${args.body.slice(0, 600)}${args.body.length > 600 ? "…" : ""}` +
                    (attached.length === 0
                      ? ""
                      : `\n\nWith ${attached.map(({ name }) => name).join(", ")}`),
                  payload: payload as never,
                },
                host.now(),
              ),
            context,
          );
          return {
            output: [
              {
                type: "text" as const,
                text: `Waiting for someone in the room to approve sending it (${approval.id}).`,
              },
            ],
            details: { approval: approval.id },
          };
        },
      });

      return {
        // Mail is written by strangers: the model reads it as data (ADR 20).
        tools: [returnsUntrusted(readsOnly(search)), returnsUntrusted(readsOnly(read)), send],
        sections: [
          section("mail", async (input, context) => {
            const room = await roomOf(input.read, input.conversationId, context).catch(
              () => undefined,
            );
            if (room === undefined) return undefined;
            const usable = usableIn(room.id);
            if (usable.length === 0) return undefined;
            return (
              "Mail accounts this conversation can read with mail_search and mail_read, and send " +
              "from with mail_send (sending waits for approval): " +
              usable.map((account) => `${account.id} (${account.from})`).join(", ") +
              "."
            );
          }),
        ],
        approvals: {
          send: async (payload, run) => {
            const mail = payload as unknown as SendPayload;
            const account = usableIn(run.room.id).find((a) => a.id === mail.account);
            if (account === undefined)
              return {
                text: `Mail account ${mail.account} isn't available here any more.`,
                isError: true,
              };
            const { attachments, ...rest } = mail;
            const files: MailAttachment[] = [];
            for (const { id, name } of attachments ?? []) {
              const found = await reachable(id, () =>
                nudge().attachments.read(
                  run.room.id,
                  id,
                  run.approval.requestedBy?.playerId,
                  run.context,
                ),
              );
              if (typeof found === "string") return { text: `Not sent: ${found}`, isError: true };
              files.push({ filename: name, contentType: found.info.mime, content: found.bytes });
            }
            const { messageId } = await backend.send(
              account,
              files.length === 0 ? rest : { ...rest, attachments: files },
            );
            return { text: `Sent from ${account.id} to ${mail.to.join(", ")} (${messageId}).` };
          },
        },
      };
    },
  });
}

export default mailExtension();
