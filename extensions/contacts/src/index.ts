export {
  type ContactsOptions,
  contactsExtension,
  default,
  describe,
  matches,
} from "./extension.ts";
export { CardDavBackend, type ContactsAccount, type ContactsBackend } from "./backend.ts";
export { KnownContacts, type KnownOptions, phoneKeys } from "./known.ts";
export { type Contact, type Labeled, parseVCards } from "./vcard.ts";
