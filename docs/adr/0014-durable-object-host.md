# 14. An assistant per Durable Object on Cloudflare

An assistant should be able to run without a machine to look after: on Cloudflare, as `packages/cloudflare`. Pi Durable already has storage on a SQLite-backed Durable Object (`openDurableObjectSqliteStorage`), so the assistant itself is unchanged; what changes is what the host does around it.

**One Durable Object per assistant, named by it.** The Worker sends everything under `/v1/a/<assistant>` to the object `idFromName(<assistant>)`, which runs protocol v1's own routes (`@nudge/server/v1`) over one assistant, WebSockets included, and answers `GET /v1/a` by asking each configured assistant's object. The object keeps the name it was first reached by in its storage, so an alarm can open it without a request.

**The platform is the lock.** On a server, `<database>.lock` keeps a second process from opening the same file, since Pi Durable holds state in memory. Cloudflare runs at most one instance of an object, and the object opens the assistant inside `blockConcurrencyWhile`, so nothing reaches it half open. `Nudge.open` takes `storage` for this: storage the host opened and keeps, with no file, lock or extension directory beside it. The native SQLite module is now loaded on first use, so `@nudge/core` loads where there is none.

**A deploy is the reload.** `nudge reload` (SIGHUP) reads the config again. Here the config is the Worker's `NUDGE_CONFIG` variable and extensions are code (subclass `NudgeAssistant`, override `options`), and changing either is a deploy, which restarts every object with the new version. An assistant taken out of the config answers 404 and wakes no more, and keeps its data.

**Alarms carry nudges across evictions.** A nudge timer sleeps in memory, and an idle object is evicted, so the object keeps its single alarm at the soonest pending nudge: set when it opens, when nudges change (`Changes`), and after each alarm. The alarm opens the assistant, whose due timers then fire as they do after a server restart, waits up to a minute for them, stays awake for the answers, and sets the next. A nudge still due after that is tried again 30 seconds on.

**The first player comes from a secret.** There is no setup wizard here: `POST /v1/a/<assistant>/claim` with `Authorization: Bearer <NUDGE_CLAIM_SECRET>` makes the first player, an admin, while the assistant has none, and returns their token. Everything after goes through the admin API, as on a server.

What this doesn't do: the server API, the setup wizard, backups, self-update and Wired are a server's and stay there, and the database is encrypted by the platform rather than with a key of ours (ADR 7). Extensions that need the host's files, programs or a browser (browser, desktop, terminal, ACC) don't run. Sockets aren't hibernatable, so an open one keeps the object in memory. Only nudges have alarms: other tasks that sleep, such as watches, go on at the object's next wake. The web UI is not served from the Worker.
