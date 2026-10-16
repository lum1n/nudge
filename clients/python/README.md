# nudge-client for Python

The Python client of [protocol v1](../../docs/protocol/v1.md): the Rust client (`../rust`) through its UniFFI bindings, built with [maturin](https://www.maturin.rs/), with an asyncio API on top.

```python
import asyncio
import nudge

async def main():
    tokens = nudge.FileTokens("~/.config/nudge/token")
    async with nudge.Client("https://nudge.example", "robin", tokens, cache="nudge.sqlite") as client:
        if tokens.get() is None:
            await client.pair(input("Pairing code: "))
        await client.send("trip", "When does the train leave?")
        async for state in client.room("trip"):
            answer = state.timeline[-1] if state.timeline else None
            if answer and answer.is_answer() and answer.status != nudge.AnswerStatus.RUNNING:
                print("".join(p.text for p in answer.parts if p.is_text()))
                break

asyncio.run(main())
```

- `Client(server, assistant, tokens, cache=None)`: the commands (`pair`, `me`, `send`, `abort`, `remember`, `decide`, …, and the admin ones), and a socket that reconnects on its own. With a `cache` file, the last views are shown while offline and unsent messages wait in an outbox, also across restarts. `send` returns `Sent.DELIVERED` or `Sent.QUEUED` (in the outbox); a message the server refuses raises `NudgeError` and stays in `state.pending` until `resend` or `dismiss`.
- `client.connection()`, `client.home()`, `client.room(id)`: watches. `async for` gives the current state, then each newer one (only the latest when several arrive at once); `wait_for(predicate, timeout)` waits for one; `close()` or `async with` stops them. A `RoomState` has the room, `live`, the whole `timeline` (earlier items, then the view's), `queue`, `approvals`, `memory`, `nudges` and `pending`; `room.load_earlier()` fetches the page before.
- `client.panel(room, extension)`: a room's socket to an extension's panel, such as `lists`, `documents` or `connectors`. `async for` or `wait_for` give the extension's frames as dicts, every one in order, `send(dict)` its inputs, and `statuses` watches the socket (closed with 4404 when the room has no such extension).
- Also `usage()`, `model_view(room)`, `push_platforms()`, `register_device(…)` and `unregister_device(token)`, `sign_out()`, and for admins `extension_setups()` and `save_extension_setups(…)` (settings and schemas as JSON text).
- `MemoryTokens`, `FileTokens`, or a subclass of `TokenStore` of your own (called from library threads).

## Develop

```bash
uv venv && uv pip install maturin pytest
.venv/bin/maturin develop --uv     # builds the Rust library into python/nudge/_ffi
.venv/bin/python -m pytest         # needs node and `pnpm build` in the repository
.venv/bin/maturin build --release  # a wheel in ../rust/target/wheels
```
