# Mail

`extensions/mail` lets rooms search and read a mailbox over IMAP and send over SMTP. Accounts are set in the extension's settings, each with the rooms that may use it:

```json
{
  "from": "./extensions/mail",
  "settings": {
    "accounts": [
      {
        "id": "family",
        "from": "Family <family@example.org>",
        "imap": {
          "host": "imap.example.org",
          "user": "family@example.org",
          "password": "${FAMILY_MAIL_PASSWORD}"
        },
        "rooms": ["family"]
      }
    ]
  }
}
```

- The model gets `mail_search`, `mail_read` and `mail_send`. Reading opens the inbox read-only, so nothing is marked read. Sending, replies included (kept in their thread), waits for someone in the room to approve it.
- SMTP defaults to the IMAP host with `imap.` changed to `smtp.`, port 465 and the same login; give `smtp` to set it.
- `rooms` lists the rooms that may use the account, by id (`*` for every room). In Settings, on the web or in the apps, you pick them by name instead; `nudge room` lists the ids.
- Mail goes to the model like any tool output: e-mail addresses, phone numbers and the like as placeholders. Names are readable.
- Some servers don't keep a copy of sent mail in Sent by themselves.
