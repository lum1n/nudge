# Coding agents

`extensions/acc` lets the assistant start, watch and steer the coding agents you run on your machines: Claude Code, Codex, Cursor, Copilot CLI, pi and opencode. It embeds [ACC](https://github.com/lum1n/acc), its core and its own SSH client, so nothing is installed on the machines and the server needs no `ssh`.

```json
{
  "from": "./extensions/acc",
  "settings": { "hosts": [{ "host": "192.168.1.20", "user": "me", "name": "devbox" }] }
}
```

- With nothing set up, it reaches the sessions on the machine Nudge runs on, as `local`, as the user Nudge runs as: those you started with the Sessh app or the `acc` CLI there, and the ones it starts. No SSH is involved; scripts run with `sh` and a login's environment, not Nudge's. Agents it starts there can read what that user can, Nudge's own data included; `"local": false` turns this off.
- Each other machine has a `host` and `port` (22) the server reaches it at, a `user`, and optionally a `name` to call it by (its address when left out). `rooms` limits which rooms may use it.
- The assistant logs in with a key of its own (`auth: "key"`, the default), made the first time and kept encrypted in the extension's secret store. Ask the assistant for its machines (`acc_hosts`) and it gives the line to add to `~/.ssh/authorized_keys` there. `auth: "agent"` uses the server's ssh-agent instead, and `auth: "password"` a `password` (`${NAME}` takes it from the environment).
- The first connection pins the machine's host key in `<database>.extensions/acc/hosts.json`. A machine that later shows another key is refused, and `nudge doctor` says so. After a reinstall, ask the assistant to trust the new key, which waits for an admin to approve it.
- `acc_start` starts an agent in a directory there with a first prompt, after someone in the room approves it (`approveStart`, default on). The agent runs detached on the machine and keeps running when Nudge restarts or the connection drops.
- The room that started a session follows it. Each permission request becomes an approval in the room: approving it lets the agent go ahead once, and denying it tells the agent no. When the agent finishes a turn, fails or exits, the room hears it with the agent's last message, like a watch. Questions the agent asks come to the room for the assistant to answer with `acc_answer`.
- `acc_sessions` lists the sessions on the machines, including ones started from elsewhere (the Sessh app, the `acc` CLI). `acc_follow` has a room follow one of them. `acc_read` shows a session's state and latest messages, commands and file changes. `acc_send`, `acc_answer` and `acc_control` (interrupt, stop, remove, compact, switch model) steer it.
- It needs ACC's Node binding. A release ships it in `acc-node/`. In a checkout, `pnpm acc:fetch` puts it in `.acc-node/`, from the ACC release `acc.sh` pins; with `ACC_SRC` set to an ACC checkout it builds it there instead (that needs cargo). `NUDGE_ACC_MODULE` points to another copy.
- Agent sessions you started by hand in a terminal aren't seen; ACC only knows the sessions it started.
