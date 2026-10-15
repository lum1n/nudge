# Nudge for Android

The Kotlin client of [protocol v1](../../docs/protocol/v1.md): the Rust client (`../rust`) through its UniFFI bindings, as an Android library (`nudge`). The Nudge app in [`apps/android`](../../apps/android) is built on it.

- `nudge.ffi`: the generated bindings, written from the Rust library at build time. `NudgeClient(ClientConfig, TokenStore)` has the commands (`pair`, `me`, `send`, `abort`, `remember`, `decide`, …, and the admin ones, as suspend functions), `connect()`/`disconnect()` for the socket, and listeners for the views. Refusals throw `NudgeException.Status` (`status`, `detail`).
- `nudge.client`: `observeConnectionState()`, `observeHomeState()` and `observeRoomState(room)` give `Observed` objects with a `StateFlow` of the latest state, for view models and Compose; a `RoomState` has the whole timeline, rebuilt from the bindings' changes. `observeLists(room)` follows a room's lists over the lists extension's panel and edits them. `close()` them when done. `MemoryTokens` and `PreferencesTokens` keep the token; `PairingLink.parse` reads a `nudge://pair` link.

```kotlin
val client = NudgeClient(
    ClientConfig(server, "robin", "my-app", "1.0", "android", File(filesDir, "nudge.sqlite").path),
    PreferencesTokens(getSharedPreferences("nudge", 0)),
)
client.connect()
client.pair(code)                      // once; the token is stored
val trip = client.observeRoomState("trip")
trip.state.collect { state -> /* state?.timeline, state?.pending, … */ }
client.send("trip", "When does the train leave?", null)
```

## Build

Needs the Android SDK (`local.properties` with `sdk.dir`, or `ANDROID_HOME`), JDK 17 for Gradle, and for the native libraries [cargo-ndk](https://github.com/bbqsrc/cargo-ndk) with the Rust targets `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android` (`rustup target add …`).

```bash
./gradlew :nudge:assembleDebug                          # bindings, native libraries
./gradlew :nudge:testDebugUnitTest -Pnudge.native=false # on this machine's JVM, no NDK needed
```

With a system Rust that has no Android targets (such as a distribution's package), a rustup of its own beside it does the cargo-ndk build: install it with `RUSTUP_HOME` and `CARGO_HOME` set to directories of its own (and `--no-modify-path`), add the three targets and `cargo install cargo-ndk` with it, and name the two directories in `local.properties` (or as Gradle properties). The rest of the build keeps the system Rust.

```properties
nudge.cargoHome=/home/robin/.local/share/cargo-android
nudge.rustupHome=/home/robin/.local/share/rustup-android
```

`-Pnudge.native=false` skips cargo-ndk; the build then has no native libraries and runs only on the JVM. The unit tests load the host build of `libnudge_ffi` and run against a server on a faux model (`node packages/server/scripts/faux-server.ts`, after `pnpm build` in the repository).
