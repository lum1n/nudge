# 16. The address book's people are known private values

"Send it to grandma" didn't work: mail and calendar take addresses, and nothing told the assistant whose they are. The `contacts` extension reads CardDAV address books, through tsdav as the calendar does, and gives the model `contacts_search`.

An address book is also a list of the very values the detectors guess at. The rules find e-mail addresses and phone numbers by their shape, and miss a Norwegian number written as `91234567` without a cue word, or one without its country code. The contacts' own values need no guessing. So the extension's detectors find every e-mail address and phone number in the address books wherever it shows up, however the number is spaced and with or without the country code or a trunk `0`.

**Whole names are hidden too, against ADR 15's default.** ADR 15 made names readable because the guessing hid everyday words ("The", "Home", "POST") and broke what the assistant does. A contact's name is not a guess, and these are the people the assistant writes to, so hiding them costs little: the model tells them apart by their stable placeholders, and passes `⟦EMAIL3⟧` on to `mail_send` as it is. To keep ADR 15's failure away:

- only a whole name of two words or more is hidden, so a contact called "Mom", "Post" or "Kiwi" leaves those words readable;
- companies' names stay readable, as organisations do (a card with `KIND:org`, Apple's `X-ABShowAs:COMPANY`, or an organisation and no personal name);
- players' display names stay readable, as everyone in a room sees who wrote what. A player who joins after their name was hidden as a contact's gets it back: the extension calls `release`, new on the extension host and `Nudge`, and the vault puts the name back wherever its placeholder is stored (ADR 15);
- `hideNames: false` hides only e-mail addresses and phone numbers.

Names are hidden as `NAME`. If the local model is turned off later and the vault releases its names, the contacts' detectors hide them again under the same placeholders the next time they show up.

What this doesn't do:

- A value stays hidden after its contact is deleted, as every vault value does; `/hidden forget` drops it.
- The address books are fetched when the assistant opens and again once they are 15 minutes old, so a contact added a minute ago isn't known yet.
- Players are checked in the background as requests are redacted, so the request that comes just as someone joins may still have their name hidden; the next one has it back.
- First names alone, and postal addresses, birthdays and nicknames, stay readable, as ADR 15 has them.
- Nothing in the address books changes; adding or editing contacts is left for later.

Amends ADR 15 for the address books' people.
