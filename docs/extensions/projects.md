# Projects

`extensions/projects` lets the assistant take a software project from idea to merged code. It plans the project with you, then supervises coding agents on an exe.dev VM of the project's own, using your Claude and ChatGPT subscriptions. It needs [`extensions/acc`](acc.md). See [ADR 26](../adr/0026-projects-a-supervisor-over-coding-agents.md) for why it works this way.

```json
{ "from": "./extensions/acc" },
{ "from": "./extensions/projects", "settings": { "maxAgents": 2 } }
```

How a project goes:

1. **Kickoff.** In any room, say "New project: a tiny Hono API with one endpoint and tests". The assistant makes a room for the project with the same people, and interviews you there one question at a time: the goal and what done means, the stack, the repo, where it deploys, and limits such as a budget.
2. **Plan gate.** It writes a brief and a plan of milestones and tasks, each task with acceptance criteria, and asks you to approve it. You can change the plan in chat first.
3. **VM.** It asks for a VM with a *Launch VM* card. On your phone, the Nudge app makes it with your exe.dev token and adds the assistant's SSH key to your exe.dev account. On the web, the card says to open the app. The assistant then sets the VM up: it installs the agent CLIs, `gh` and Node where they're missing, clones the repo, and writes the secrets.
4. **Your logins.** It asks once, on cards with a password field, for `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `CODEX_AUTH_JSON` (the contents of `~/.codex/auth.json` after `codex login`) and `GH_TOKEN` (a fine-grained token for the repo). Only an admin can give these.
5. **Work.** Each ready task of the current milestone gets an agent, in its own worktree on branch `task/<id>`, at most `maxAgents` at a time. When an agent says it is done, the assistant records its PR and has another agent review it. It answers routine questions itself, and checks on agents that have been quiet for `stallMinutes`.
6. **Progress.** The room gets short posts when a task is done, a PR is opened, or something is blocked. A daily digest goes out at `digestHour`. The **Project** page (web and Android, from the room) shows the milestones, tasks, working agents, PRs and their CI, the VM, the names of the secrets, and spend, with Pause and Resume.
7. **Steering.** Write in the room at any time. The assistant changes the plan and passes the change on to agents that are working. You can also say "pause", "resume", "stop task 4" or "skip to milestone 3".
8. **Merge gate.** When every task of a milestone is in review and CI passes, a card asks to merge its PRs. On approval they merge in order with `gh` on the VM, and the next milestone starts. If you deny it, say in the room what to change.
9. **Done.** A final report: what was built, the links, open issues, and what you have to do yourself. Then a *Delete VM* card, which runs on the phone, or keep the VM.

Secrets, such as `STRIPE_KEY` when a task needs one, are asked for with `project_request_secret` on a card with a password field. The value goes to the server's encrypted store and from there to the VM's `~/.nudge/project.env` (mode 0600). It goes only on a script's standard input, never inside a script. The model is only told that the key is set. Anything an agent prints passes through a scrubber before the room or the model sees it.

The project pauses, and asks whether to go on, once it has spent `budgetWarnAt` (80%) of its budget. Spend is the model's spend in the project's room. Your agent subscriptions aren't counted.

Settings:
- `maxAgents` (2): how many agents work on a project at once.
- `harness` (`claude`) and `reviewHarness` (`codex`): the agents that build tasks and the ones that review them.
- `vmUser` (`exedev`): the user agents run as on the VM, unless exe.dev says another. `vmImage`: the image new VMs run.
- `stallMinutes` (20), `digestHour` (9), `wakesPerHour` (20), `budgetWarnAt` (0.8).

Tools: `project_create`, `project_plan`, `project_start`, `project_request_vm`, `project_bootstrap`, `project_request_secret`, `project_status`, `project_task_start`, `project_task_update`, `project_gate`, `project_pause`, `project_resume` and `project_finish`.

The panel is the extension's room socket, `WS /a/<assistant>/rooms/<room>/ext/projects`. It sends `{ type: "project", project }` when it opens and on every change (`project` is `null` in a room without one). It takes `{ type: "pause" }` and `{ type: "resume" }`, and answers each with `{ type: "ok" }` or `{ type: "error", message }`.

Not tried on a real exe.dev account yet: what the default image ships, whether a token scoped to `new` may run `ssh-key add`, and which SSH user the VMs have. If adding the key fails, the app says so and the assistant gives the line to add by hand.
