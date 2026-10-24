# Use desktop apps

`extensions/desktop` gives the assistant a `use_desktop` tool, for apps with no better way in. The room's model hands it a task, and a desktop agent on its own model works the apps you list on a Linux desktop of the room's own:

```json
{
  "from": "./extensions/desktop",
  "settings": {
    "apps": {
      "writer": ["env", "SAL_USE_VCLPLUGIN=qt6", "libreoffice", "--writer"],
      "editor": ["gnome-text-editor"]
    }
  }
}
```

- Only the apps in `apps` can be started, by name: the program and its arguments. There is no shell. Left out, `apps` is the ones the server has of LibreOffice Writer and Calc (on their Qt backend), GNOME Text Editor and Dolphin; the server image has Writer and Calc.
- The model never sees the screen. It reads the windows as text from their accessibility tree (AT-SPI), open menus and dialogs first, and acts on element refs, so any tool-calling model can drive it and every window passes through the same redaction as the rest of Nudge. Password fields always read `[hidden]`.
- `model`, `reasoning`, `maxSteps` and `idleMinutes` work as for the browser; `model` defaults to `anthropic/claude-haiku-5-5`.
- Each room gets its own virtual display (`Xvfb`), session bus and accessibility bus, so nothing reaches your own desktop. The apps' home, with their settings and files, is `<database>.extensions/desktop/homes/conversation-<id>` and stays between tasks; the desktop and its apps close after `idleMinutes` (default 10), and when Nudge stops. The server needs `Xvfb`, `dbus-daemon` and `at-spi2-core`, and GTK, Qt or Chromium-based apps.
- It does not send, delete, pay, publish or save over a file on its own. It gets everything ready, stops, and asks the room to approve the exact step, as for the browser; approving it carries on on the same desktop. The desktop refuses, until someone approves, a click on (or Enter or Space on) a button, menu item or link labelled as for the browser ("Send", "Delete", "Publish"), Control+Enter, which sends in mail and chat apps, and Delete on files or mail.
- While `use_desktop` runs, the chat and the terminal show what it is doing (`Clicking "Save"…`).
- The room's desktop is live in the web app (the Desktop button in a room) and in the Android, iOS and macOS apps (About this room): the people in the room see its screen as it changes, and the one in control clicks and types into it, starts apps and brings windows to the front (there is no window manager); the others watch and can take control, as with the browser. The pictures go only to them, never to a model.
- Tried with GNOME Text Editor (GTK 4), LibreOffice Writer and Calc, Dolphin (Qt 6) and Firefox. LibreOffice has to run on its Qt backend, as above: on its GTK 3 backend it aborts when its windows are read. A spreadsheet reads as the cells on the screen that hold something; the agent moves around with the Name Box. Dolphin's inline rename field is invisible to it (it can still press F2 and type).
- The apps run in a bubblewrap sandbox (`sandbox`, on by default): they see the system's programs and libraries read-only, their desktop's home, display and buses, and nothing else of the machine: no other homes, not Nudge's data or config, and none of Nudge's environment (its keys). They reach the internet through slirp4netns, as the terminal's commands do, without this machine's own services (`127.0.0.1`, such as signal-cli's daemon) or the local network: private, link-local and CGNAT (Tailscale) addresses are blocked in the desktop's network. That needs `slirp4netns`, `unshare`, `nsenter` and `ip` on the server and `/dev/net/tun` (the `devices` line in Docker); with `"localNetwork": true` the apps reach what the server reaches, and slirp4netns isn't needed. `readable` lists more directories they may read, such as where an app is unpacked outside `/usr` and `/opt`. The sandbox needs `bwrap` and user namespaces. Docker allows them only with seccomp, AppArmor and its masked `/proc` paths loosened (`security_opt` in [`packages/release/compose.yaml`](../../packages/release/compose.yaml), with the `stable-desktop` image); the other way is `sandbox` off, which runs the apps as the user Nudge runs as, able to read whatever it can, its data and keys included. `nudge doctor` says whether the sandbox works.
- `pnpm -C extensions/desktop eval -- --model anthropic/claude-haiku-5-5` runs a set of tasks in these apps (open and read files, write and save, count and rename files, read a page, and one that must stop to ask before deleting), each on a fresh desktop and home, and checks the answers and the files left behind (sandboxed, with the directory of `--apps`' file readable; `--no-sandbox` turns that off); otherwise it works as the browser eval, with its leak check, writing to `extensions/desktop/.eval/`. `--apps apps.json` says how to start apps that are installed elsewhere, as `{ "calc": ["env", "SAL_USE_VCLPLUGIN=qt6", "/opt/libreoffice/program/soffice", "--calc"] }`.
