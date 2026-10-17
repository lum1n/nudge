# Nudge clients in Rust

A client of [protocol v1](../../docs/protocol/v1.md), for Rust and, through [UniFFI](https://mozilla.github.io/uniffi-rs/), for Swift, Kotlin and Python.

- `nudge-protocol`: the protocol's types and `apply` for patches. No IO.
- `nudge-client`: `Api` (HTTP), `Connection` (the socket), `RoomListStore` and `RoomStore` (views), and `NudgeClient`, with a SQLite cache of views and an outbox that sends what didn't get through once the socket is open.
- `nudge-ffi`: the UniFFI bindings of `nudge-client`.

```bash
cargo test                      # the server tests need `pnpm build` in the repository first
cargo build -p nudge-ffi        # target/debug/libnudge_ffi.{so,dylib,a}
cargo run -p nudge-ffi --features cli --bin uniffi-bindgen -- \
  generate --library target/debug/libnudge_ffi.so --language python --out-dir out
```

`--language` takes `swift`, `kotlin` or `python`. The tests check the types against `packages/protocol/schema/v1.json`, replay `packages/protocol/test/fixtures/room-stream.jsonl`, and run against a real server on a faux model (`packages/server/scripts/faux-server.ts`).
