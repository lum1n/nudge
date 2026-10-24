# Code mode

`extensions/codemode` gives the model one `codemode` tool: it writes a short JavaScript program that calls the room's tools as `tools.<name>(args)`, so it can loop, filter and combine their results in one step instead of one tool call per turn.

```json
{ "from": "./extensions/codemode", "settings": { "timeoutSeconds": 30 }, "rooms": [] }
```

- Scripts run in QuickJS inside a worker thread, with no network, files, environment or timers. They stop after `timeoutSeconds` (default 30, counting their tool calls) or when they use more than `memoryMb` (default 64).
- Every tool call a script makes goes through the room's normal tool handling: writes still wait for approval, and only the script's output reaches the model, redacted like any other tool result.
- `"models": true` also gives scripts classifiers and image generation, through the same redaction. It is off by default because each call is a paid request.
- `"rooms": []` installs it switched off everywhere, so rooms turn it on with `/extensions on codemode`.
