# Scripts

`extensions/scripts` lets the assistant write the steps of a lookup it repeats once, as a short JavaScript program, and run it again by name. Examples: "the Finn search for a 2027 GLC under 800 000 kr", "tomorrow's power prices from the connector". The model saves one with `save_script`, which runs it once as a test and keeps it only if that works. It runs it with `run_script`, and `list_scripts`, `show_script` and `remove_script` manage them per room.

```json
{ "from": "./extensions/scripts", "settings": { "timeoutSeconds": 30, "maxPerRoom": 20 } }
```

- Scripts run like code mode's: QuickJS in a worker thread, with no network, files or environment. They call tools as `await tools.<name>(args)` and get `args` from whoever runs them. They stop after `timeoutSeconds` or past `memoryMb`.
- **Scripts only read.** A script sees, and can call, only the tools marked as reading (`readsOnly` in `@nudge/core`): web search and pages, feeds, reading mail, calendar and contacts, documents and lists, connector `GET` calls, and coding agents' sessions. Anything that changes something or asks for approval is refused, because a script often runs with nobody watching.
- A script is kept as the model wrote it, with placeholders for personal values, and runs with the values. What it returns goes back to placeholders before the model sees it.
- For a watch, a script returns `{"items":[{"key":"…","text":"…"}]}`, and optionally `"message"`.
- A script saved in a private turn is its owner's alone. A name is used once per room: a private save can't replace a public script, nor a public save someone's private one.
- A watch's every check is a run that stays in the database. When the assistant starts, it deletes all but the last `keepRuns` (default 20) of each watch.
