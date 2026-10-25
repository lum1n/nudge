# Use the terminal

`extensions/terminal` gives the model a `run_command` tool: a bash command, run in a terminal of the room's own, for command-line tools such as `pandoc`, `ffmpeg`, `jq`, `git` or a quick Python script.

```json
{
  "from": "./extensions/terminal",
  "settings": {
    "network": false,
    "timeoutSeconds": 60,
    "memoryMB": 2048,
    "workspaceMB": 2048,
    "desktopFiles": false
  }
}
```

- Every command runs in a bubblewrap sandbox. It sees the system's programs and libraries read-only, the room's workspace at `/workspace` (on the server `<database>.extensions/terminal/workspaces/conversation-<id>`, kept between commands), an empty `/tmp`, and nothing else of the machine: not your home, not Nudge's data or config, and none of Nudge's environment (its keys). It has its own processes, hostname and IPC. A command stops after `timeoutSeconds` (default 60, at most 600), and gets at most 512 processes and 1 GB per file it writes. The model gets the start and end of the output, past 30 000 characters, redacted like any tool's.
- A command gets `memoryMB` of memory (default 2048). Where the server's systemd gives the user a cgroup (`systemd-run --user --scope` with the memory controller), that is for everything it starts together, and going over stops it; elsewhere, such as in Docker, each of its programs gets that much address space on its own (`ulimit -v`), so a program that reserves more fails to start. `/tmp` is in memory and holds no more than that, with bubblewrap 0.10 or later.
- A room's workspace holds `workspaceMB` (default 2048). It is measured every second while a command runs, and a command that grows it past that is stopped; one that is already over still runs, so files can be deleted, but can't grow it. `document_to_workspace` copies nothing into a full one.
- It has no network unless `"network": true`. Then commands reach the internet through [slirp4netns](https://github.com/rootless-containers/slirp4netns), without this machine's own services (`127.0.0.1`, such as signal-cli's daemon) or the local network: private, link-local and CGNAT (Tailscale) addresses are blocked in the sandbox's network, and it has a DNS server of its own. That needs `slirp4netns`, `nsenter` and `ip` on the server (in the Docker image); commands with that network run as root of their own user namespace, without any capabilities. With `"localNetwork": true` as well, commands reach what the server reaches, the local network and this machine's services too, and slirp4netns isn't needed.
- Commands have the programs the server has. The model is told which of git, Python, Node, pandoc, ffmpeg, ImageMagick, pdftotext, sqlite3, jq and curl are there. The server image doesn't install them, so in Docker the terminal has little more than the basic tools for files, text and archives.
- Files move between the workspace and the room's documents (`extensions/documents`, when it is on in the room): `document_to_workspace` copies an uploaded document into `/workspace`, never over a file there, and `workspace_to_documents` adds a file from it to the room's documents, where people download it from the Documents page. Files of kinds the documents don't read, such as `.docx`, are kept without their text. Both go through the sandbox, so a link in the workspace leads nowhere a command couldn't go.
- With `"desktopFiles": true`, commands read and write the room's desktop's home (`extensions/desktop`, its apps' files) at `/desktop`, such as to convert with `pandoc` what Writer saved there.
- Each command is read before it runs, through pipes, `&&`, `$(…)`, `sh -c`, `xargs`, `find -exec` and wrappers like `env` or `timeout`:
  - Common tools that read, search, convert, build and fetch run at once.
  - Commands that delete files (`rm`, `find -delete`, `git clean`, `git reset --hard`), send data (`curl -d`, `curl -X POST`, `git push`, `ssh`, `scp`, mail), run a script of the workspace, run a program not on the list, or that it can't read for sure (a program named by a variable, `sh` reading its input) wait for someone in the room to approve that exact command, as an approval like any other. Approving it runs it, and the room hears the output.
  - `sudo`, `su`, `mount`, `docker`, `systemctl` and the like never run.
  - With the network on, every command waits for approval once the assistant has read mail, a web page, a document or another outside text in the same turn, since it could send that on ([ADR 20](../adr/0020-untrusted-content-and-outbound-calls.md)).
- The room's terminal is live in the web app (the Terminal button in a room) and in the Android app (About this room): the people in the room see each command the assistant runs, its output as it comes, how it ended, and those that wait for approval, with Approve and Deny. It is only watched; nobody types into it. Output there is as the command printed it, not redacted: the people in the room may see it, like a tool call's output in the chat; a command run in answer to something private shows only to whom it is private to. The last 30 commands of a room are kept, the end of each one's output up to 50 000 characters, in `<database>.extensions/terminal/commands`, so they outlast a restart.
- `allow`, `ask` and `deny` add program names to those lists and override them; a program in `allow` runs however it is called.
- Code given inline to an interpreter (`python3 -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`) is read too, by the calls it makes: code that deletes files (`os.remove`, `shutil.rmtree`, `fs.rmSync`, `unlink`), connects elsewhere (`urllib.request`, `requests`, `socket`, `fetch`) or runs other commands (`subprocess`, `os.system`, `child_process`) waits for approval; the rest, such as reading a JSON file, runs at once. `"allow": ["python3"]` runs all of it without asking.
- That reading is best effort, and it doesn't cover scripts or code an interpreter reads from its input: `python3 script.py`, a Node script, `python3 - <<'EOF'` or `echo '…' | node` can delete workspace files or, with the network, send them without asking. Inline code built from a variable (`python3 -c "$code"`) asks, as it can't be read before it runs. Interpreters run without asking on purpose: running scripts is what the terminal is for, and asking for each would make it useless. The sandbox and its limits are what keep commands from the rest of the machine; put `python3`, `node` and the like in `ask` to have every use of them approved.
- `readable` lists more directories commands may read, such as where a tool is installed outside `/usr` and `/opt`.
- It needs `bwrap`, `bash` and user namespaces, like the desktop's sandbox; in Docker, the `security_opt` lines in [`packages/release/compose.yaml`](../../packages/release/compose.yaml). Without them it runs nothing, and `nudge doctor` says why.
