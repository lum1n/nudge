import {
  BACKGROUND_CONTEXT,
  defineNudgeExtension,
  defineTool,
  readsOnly,
  roomOf,
  roomsSetting,
  section,
  Type,
} from "@nudge/core";
import { fillVariables } from "@nudge/bridge";
import { CardDavBackend, type ContactsAccount, type ContactsBackend } from "./backend.ts";
import { KnownContacts } from "./known.ts";
import type { Contact } from "./vcard.ts";

const VERSION = "0.1.0";
const MINUTE = 60_000;
/** Contacts older than this are fetched again when next used. */
const STALE_MS = 15 * MINUTE;
/** After a failed fetch, the next try in the background waits this long. */
const RETRY_MS = 5 * MINUTE;
/** Most contacts one search shows. */
const MAX_SHOWN = 10;

const AccountSettings = Type.Object({
  id: Type.String({
    pattern: "^[a-z0-9][a-z0-9-]*$",
    description: "A short name for the account, in lowercase letters, digits and dashes.",
  }),
  url: Type.String({
    pattern: "^https?://",
    title: "CardDAV URL",
    description: "The address of the CardDAV server, starting with http:// or https://.",
  }),
  user: Type.String({
    description: "The user name to log in with; ${NAME} takes it from an environment variable.",
  }),
  /** `${NAME}` takes it from the host's environment, so it stays out of nudge.json. */
  password: Type.String({
    writeOnly: true,
    description:
      "The password to log in with; write ${NAME} to take it from an environment variable instead.",
  }),
  addressBooks: Type.Optional(
    Type.Array(Type.String(), {
      title: "Address books",
      description: "Use only the address books with these names; leave empty for all of them.",
    }),
  ),
  /** Room ids that may use the account; `*` for every room. */
  rooms: roomsSetting({ title: "Rooms", description: "The rooms that may look people up here." }),
});

const Settings = Type.Object({
  accounts: Type.Array(AccountSettings, {
    default: [],
    description: "The CardDAV accounts the assistant can look people up in.",
  }),
  hideNames: Type.Boolean({
    default: true,
    title: "Hide names",
    description:
      "Keep the contacts' whole names from the model, not only their e-mail addresses and phone " +
      "numbers. Names of one word, such as Mom, stay readable.",
  }),
});

export type ContactsOptions = {
  /** The CardDAV servers; tests pass a fake. */
  readonly backend?: ContactsBackend;
};

/** The contacts extension with its backend chosen; the default export uses CardDAV. */
export function contactsExtension(options: ContactsOptions = {}) {
  return defineNudgeExtension({
    name: "contacts",
    version: VERSION,
    apiVersion: "1.0",
    description:
      "Look people up in CardDAV address books; their names, e-mail addresses and phone numbers " +
      "stay hidden from the model.",
    settings: Settings,
    setup: (host) => {
      const backend = options.backend ?? new CardDavBackend();
      const accounts: ContactsAccount[] = host.settings.accounts.map((account) => ({
        ...account,
        user: fillVariables(account.user, process.env, "contacts"),
        password: fillVariables(account.password, process.env, "contacts"),
      }));
      const loaded = new Map<string, { readonly at: number; readonly contacts: Contact[] }>();
      const loading = new Map<string, Promise<Contact[]>>();
      const failed = new Map<string, { readonly at: number; readonly message: string }>();
      let closed = false;
      // Players' display names stay readable, as everyone in a room sees who wrote what. One who
      // joins after their name was hidden as a contact's gets it back readable.
      let readable = new Set<string>();
      let checking: Promise<void> | undefined;
      const checkPlayers = async () => {
        const players = await host.assistant().players.list(BACKGROUND_CONTEXT);
        const names = new Map(
          players.map((player) => [player.displayName.trim().toLowerCase(), player.displayName]),
        );
        const added = [...names].filter(([name]) => !readable.has(name));
        if (added.length === 0 && names.size === readable.size) return;
        const hidden = added.filter(([, name]) => known.hides(name));
        readable = new Set(names.keys());
        remember();
        for (const [, name] of hidden) await host.release(name);
      };
      const known = new KnownContacts(() => refreshStale());
      const remember = () =>
        known.set(
          [...loaded.values()].flatMap(({ contacts }) => contacts),
          { names: host.settings.hideNames, readable },
        );
      const load = (account: ContactsAccount): Promise<Contact[]> => {
        let pending = loading.get(account.id);
        if (pending !== undefined) return pending;
        pending = (async () => {
          try {
            const contacts = await backend.contacts(account);
            loaded.set(account.id, { at: host.now(), contacts });
            failed.delete(account.id);
            remember();
            return contacts;
          } catch (error) {
            failed.set(account.id, { at: host.now(), message: (error as Error).message });
            throw error;
          } finally {
            loading.delete(account.id);
          }
        })();
        loading.set(account.id, pending);
        return pending;
      };
      /** Fetches what is missing or old in the background, so the detectors know it. */
      const refreshStale = () => {
        if (closed) return;
        checking ??= checkPlayers()
          .catch(() => {})
          .finally(() => {
            checking = undefined;
          });
        const now = host.now();
        for (const account of accounts) {
          if (loading.has(account.id)) continue;
          const at = loaded.get(account.id)?.at;
          if (at !== undefined && now - at < STALE_MS) continue;
          const failure = failed.get(account.id);
          if (failure !== undefined && now - failure.at < RETRY_MS) continue;
          load(account).catch(() => {});
        }
      };
      /** The account's contacts, fetched again when old; the old ones when that fails. */
      const contactsOf = async (account: ContactsAccount): Promise<Contact[]> => {
        const had = loaded.get(account.id);
        if (had !== undefined && host.now() - had.at < STALE_MS) return had.contacts;
        try {
          return await load(account);
        } catch (error) {
          if (had !== undefined) return had.contacts;
          throw error;
        }
      };
      void host.whenOpen().then(refreshStale);

      const usableIn = (roomId: string) =>
        accounts.filter((account) => account.rooms.includes("*") || account.rooms.includes(roomId));
      const text = (value: string, isError = false) => ({
        output: [{ type: "text" as const, text: value }],
        ...(isError ? { isError } : {}),
      });

      const search = defineTool({
        name: "contacts_search",
        description:
          "Find people in the address books this conversation may use, with their e-mail " +
          "addresses, phone numbers, postal addresses and birthdays. Search by name, nickname, " +
          "relation as the contact is saved (grandma, mormor), company, e-mail address or phone " +
          "number; if a relation finds nothing, try it in the other language.",
        parameters: Type.Object({
          query: Type.String({ description: "Words that must all match, such as Ingrid Hansen." }),
          account: Type.Optional(
            Type.String({ description: "Account id; default every one here." }),
          ),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const usable = usableIn(room.id);
          if (usable.length === 0)
            return text("No address book is set up for this conversation.", true);
          const chosen =
            args.account === undefined
              ? usable
              : usable.filter((account) => account.id === args.account);
          if (chosen.length === 0)
            return text(
              `No contacts account "${args.account}" here; there is ${usable.map((a) => a.id).join(", ")}.`,
              true,
            );
          const words = fold(args.query).split(/\s+/).filter(Boolean);
          if (words.length === 0) return text("Say whom to look for.", true);
          const found: { contact: Contact; account: string; rank: number }[] = [];
          const problems: string[] = [];
          for (const account of chosen) {
            let contacts: Contact[];
            try {
              contacts = await contactsOf(account);
            } catch (error) {
              problems.push(`Could not read ${account.id}: ${(error as Error).message}`);
              continue;
            }
            for (const contact of contacts) {
              const rank = matches(contact, words);
              if (rank !== undefined) found.push({ contact, account: account.id, rank });
            }
          }
          found.sort((a, b) => a.rank - b.rank || a.contact.name.localeCompare(b.contact.name));
          const lines = found
            .slice(0, MAX_SHOWN)
            .map(({ contact, account }) =>
              describe(contact, chosen.length > 1 ? account : undefined),
            );
          if (found.length > MAX_SHOWN)
            lines.push(`…and ${found.length - MAX_SHOWN} more; search with more words.`);
          if (found.length === 0) lines.push(`Nobody matches "${args.query}".`);
          return text([...problems, ...lines].join("\n"), problems.length === chosen.length);
        },
      });

      return {
        tools: [readsOnly(search)],
        detectors: known.detectors,
        sections: [
          section("contacts", async (input, context) => {
            const room = await roomOf(input.read, input.conversationId, context).catch(
              () => undefined,
            );
            if (room === undefined) return undefined;
            const usable = usableIn(room.id);
            if (usable.length === 0) return undefined;
            return (
              `Address books this conversation can search with contacts_search: ` +
              `${usable.map((a) => a.id).join(", ")}. When someone names a person or calls them ` +
              `by relation ("send it to grandma") and you need their e-mail address, phone number ` +
              `or address, look them up there before asking. Their names, e-mail addresses and ` +
              `phone numbers reach you as placeholders such as ⟦EMAIL3⟧; pass those on as they are.`
            );
          }),
        ],
        problems: () =>
          [...failed].map(
            ([id, failure]) => `Could not read the contacts of ${id}: ${failure.message}`,
          ),
        close: () => {
          closed = true;
        },
      };
    },
  });
}

/**
 * Whether every word is in the contact, and how well: 0 when the words are its whole name or a
 * nickname, 1 when the name starts with them, 2 otherwise.
 */
export function matches(contact: Contact, words: readonly string[]): number | undefined {
  const names = [contact.name, ...contact.nicknames].map(fold);
  const fields = [
    ...names,
    fold(contact.given ?? ""),
    fold(contact.family ?? ""),
    fold(contact.org ?? ""),
    ...contact.emails.map(({ value }) => value.toLowerCase()),
  ];
  const digits = contact.phones.map(({ value }) => value.replace(/\D/g, ""));
  const found = words.every((word) => {
    if (fields.some((field) => field.includes(word))) return true;
    const number = word.replace(/\D/g, "");
    return number.length >= 4 && digits.some((phone) => phone.includes(number));
  });
  if (!found) return undefined;
  const query = words.join(" ");
  if (names.includes(query)) return 0;
  return names.some((name) => name.startsWith(query)) ? 1 : 2;
}

/** A contact as the model reads it, a line for each way to reach them. */
export function describe(contact: Contact, account?: string): string {
  const head = [
    contact.name,
    ...(contact.nicknames.length === 0 ? [] : [`(${contact.nicknames.join(", ")})`]),
    ...(contact.org === undefined ? [] : [`– ${contact.org}`]),
    ...(account === undefined ? [] : [`[${account}]`]),
  ].join(" ");
  const line = (what: string, { value, label }: { value: string; label?: string }) =>
    `  ${what}: ${value}${label === undefined ? "" : ` (${label})`}`;
  return [
    head,
    ...contact.emails.map((email) => line("e-mail", email)),
    ...contact.phones.map((phone) => line("phone", phone)),
    ...contact.addresses.map((address) => line("address", address)),
    ...(contact.birthday === undefined ? [] : [`  birthday: ${contact.birthday}`]),
  ].join("\n");
}

/** Lower case without accents, so "andre" finds André. */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export default contactsExtension();
