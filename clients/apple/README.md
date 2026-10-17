# Nudge for Apple platforms

The Swift client of [protocol v1](../../docs/protocol/v1.md): the Rust client (`../rust`) through its UniFFI bindings, as a Swift package for iOS 26 and macOS 26.

- `NudgeFFI` (re-exported by `Nudge`): the generated bindings. `NudgeClient(config:tokens:)` has the commands (`pair`, `me`, `send`, `abort`, `remember`, `decide`, …, and the admin ones, as async functions), `connect()`/`disconnect()` for the socket, and listeners for the views. Refusals throw `NudgeError.Status(status:detail:)`.
- `Nudge`: `observeConnectionState()`, `observeRoomListState()` and `observeRoomState(_:)` give `@Observable` objects on the main actor with the latest `value`, for SwiftUI; a `RoomState` has the whole timeline, rebuilt from the bindings' changes. `observeLists(_:)`, `observeDocuments(_:)`, `observeConnectors(_:)` and `observeBrowser(_:)` follow a room's lists, documents (upload and download them), connectors (keys, the local network, read paths) and browser (its frames, and taps and typing sent back) over the extensions' panels. `ExtensionSetup.settingFields` reads an extension's settings schema, from `extensionSetups()`, as fields for a form. `MemoryTokens` and `KeychainTokens` keep the token; `PairingLink` reads a `nudge://pair` link. The Nudge app in [`apps/apple`](../../apps/apple) is built on this package.

```swift
let client = try NudgeClient(
    config: ClientConfig(server: server, assistant: "robin", clientName: "my-app", clientVersion: "1.0",
                         platform: "ios", cachePath: cacheURL.path),
    tokens: KeychainTokens(account: "robin"))
client.connect()
_ = try await client.pair(code: code)        // once; the token is stored
let trip = client.observeRoomState("trip")   // trip.value?.timeline, trip.value?.pending, …
_ = try await client.send(room: "trip", text: "When does the train leave?", whenBusy: nil)
```

## Build

```bash
scripts/build.sh                 # writes the bindings into Sources/
scripts/build.sh --xcframework   # macOS: also NudgeFFIC.xcframework for iOS, the simulator and macOS
swift test                       # needs node and `pnpm build` in the repository
```

`--xcframework` needs Xcode and the Rust targets `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`, `aarch64-apple-darwin` and `x86_64-apple-darwin`. On Linux the package links the host's `../rust/target/debug/libnudge_ffi.so` instead, so the bindings and the tests run there too (SwiftUI and the keychain don't).
