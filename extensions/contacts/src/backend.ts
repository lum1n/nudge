import { createDAVClient, type DAVAddressBook } from "tsdav";
import { type Contact, parseVCards } from "./vcard.ts";

/** One CardDAV account as the extension uses it, its password filled in. */
export type ContactsAccount = {
  readonly id: string;
  /** The CardDAV server, such as `https://carddav.fastmail.com` or `https://contacts.icloud.com`. */
  readonly url: string;
  readonly user: string;
  readonly password: string;
  /** Only the address books with these names; all when absent. */
  readonly addressBooks?: readonly string[];
  /** Room ids that may use it; `*` for every room. */
  readonly rooms: readonly string[];
};

/** What the extension needs from a CardDAV server; tests put a fake in its place. */
export interface ContactsBackend {
  /** Every contact in the account's address books, filtered by its `addressBooks`. */
  contacts(account: ContactsAccount): Promise<Contact[]>;
}

type Client = Awaited<ReturnType<typeof createDAVClient>>;

/** CardDAV through tsdav, one client per account, made on first use. */
export class CardDavBackend implements ContactsBackend {
  private readonly clients = new Map<string, Promise<Client>>();

  async contacts(account: ContactsAccount): Promise<Contact[]> {
    const client = await this.client(account);
    const books = (await client.fetchAddressBooks()).filter(
      (book) => account.addressBooks === undefined || account.addressBooks.includes(nameOf(book)),
    );
    const found: Contact[] = [];
    for (const addressBook of books)
      for (const card of await client.fetchVCards({ addressBook }))
        if (typeof card.data === "string") {
          try {
            found.push(...parseVCards(card.data));
          } catch {
            // One card the parser can't read leaves the others.
          }
        }
    return found;
  }

  private client(account: ContactsAccount): Promise<Client> {
    let client = this.clients.get(account.id);
    if (client === undefined) {
      client = createDAVClient({
        serverUrl: account.url,
        credentials: { username: account.user, password: account.password },
        authMethod: "Basic",
        defaultAccountType: "carddav",
      });
      // A failed login is tried again next time, not remembered.
      client.catch(() => this.clients.delete(account.id));
      this.clients.set(account.id, client);
    }
    return client;
  }
}

function nameOf(book: DAVAddressBook): string {
  return typeof book.displayName === "string" && book.displayName !== ""
    ? book.displayName
    : book.url;
}
