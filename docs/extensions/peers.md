# Assistants talking to each other

`extensions/peers` lets this assistant talk to assistants on other servers, such as to find a time with Ann's household or hand her assistant a request (ADR 23). It needs `extensions/federation` and uses its keys: everything between the two is signed and encrypted the same way.

```json
{ "from": "./extensions/peers", "settings": { "offer": ["calendar"] } }
```

- **Link first.** Someone asks in chat ("link with nudge.ann.no/robin"); the model calls `link_assistant`, and an admin here approves sending the request. Ann's admins get an approval in their lobby and decide. An admin can also `POST /ext/peers/links` with `{ address, note }`. `list_links` and `unlink_assistant` (admins) show and end links; `GET /ext/peers/links` and `DELETE /ext/peers/links/<id>` do it for apps.
- **A linked assistant is a guest.** Each side makes a player for the other ("Robin (assistant)"), with no token and no admin rights, and a shared room for it with the admins: "With Robin". Its messages arrive there as that player's, so redaction, the per-player budget and approvals work as for anyone, and the admins can read along. It can use only the extensions on in that room: `offer` picks them for a new link (none by default besides this one), and the room's own switches change them later.
- **Threads.** `talk_to_assistant` (a link, a goal, and what the other side needs to know) starts a thread in a side conversation of the room, out of its sight. The model there writes with `say`, reads each reply, and ends with `finish_thread`. The room hears how it went like a fired nudge, so push and chat bridges deliver it, and `show_thread` shows the whole conversation. On the other side, the answer to each message goes back; when its people approve something later, the answer to that follows up, also after the thread ended.
- **Privacy.** What goes out is shown as the other assistant's player may see it: values someone made private stay placeholders. The receiving side protects what arrives in its own vault. Messages from another assistant are marked as its words, not instructions, and a link's room and a thread can't start threads of their own.
- **Limits.** `maxRounds` (default 6) replies read per thread, `replyHours` (default 24) to wait for one, `maxThreadsPerHour` (default 10) threads each linked assistant may start here, `maxChars` (default 4000) per message. `onlyAdmins` keeps starting threads to admins.
