# Nudge for iPhone, iPad and Mac

The Nudge app for iOS 26 and macOS 26 (and later), in SwiftUI, on the Swift package in [`clients/apple`](../../clients/apple) (the Rust core through UniFFI). Bundle id `app.nudge.dev`.

- Sign in with a pairing code (`nudge pair <player>` on the server) or by opening a `nudge://pair?…` link. The token goes in the keychain.
- Rooms: a sidebar on the Mac and the iPad, a list on the iPhone. Each row shows when the assistant is answering and how many actions wait for approval.
- A room: the timeline as it streams (text, thinking, tool calls), approvals to approve or deny, fired nudges, messages on their way (with Retry and Dismiss when one fails), Stop, and earlier messages on demand. Views and unsent messages are cached, so the app opens offline and sends what waited once it's back.
- Privacy in shared rooms: the lock by the message field sends a message only you see, with its answer; others see that you sent one. Values someone else keeps to themselves show as *hidden*. Under Settings, "Only you see" hides an address, a name or a number in every room, and forgets one for good. A running tool shows what it is doing, such as the browser's `Clicking "Search"…`.
- Lists, documents (upload, download, delete, find by name) and connectors (API keys, typed and never shown again, the local network, read paths), over the extensions' panels, and the room's members, memory, nudges, extensions and what the model saw.
- The room's browser, live, from About this room or from "Open the room's browser to log in" when the assistant needs a login: tap to click, drag to scroll, type into the page, Take control from whoever has it, Done (and Remember, to save the login), and the saved logins.
- Settings: for admins, the assistant's extensions (on or off, their settings as a form drawn from each one's schema, and the rooms they are on in), your own memory and whether it's shared, this month's spend, notifications, sign out.
- Liquid Glass throughout: the timeline scrolls under a floating glass bar with the composer (Send morphs into Stop), actions waiting for approval and the live status; glass message bubbles (yours tinted), tool calls, nudges, markers and badges; glass buttons for approve/deny, retry, sign-in and load earlier. Toolbars, sidebars and sheets get the system's glass on their own.
- Notifications through APNs when an answer is ready or an action waits for approval in a room you don't have open. The app disconnects in the background so the server knows to push. Tapping one opens the room.

## Build

On a Mac with Xcode 26 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`), and Rust with the Apple targets:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin
../../clients/apple/scripts/build.sh --xcframework   # the Rust core for iOS, the simulator and macOS
xcodegen                                              # writes Nudge.xcodeproj from project.yml
open Nudge.xcodeproj
```

Run `build.sh --xcframework` again after the Rust core changes, and `xcodegen` after adding files or changing `project.yml`. Pick your team under Signing & Capabilities (or set `DEVELOPMENT_TEAM` in `project.yml`); the Nudge-iOS and Nudge-macOS schemes build the two apps.

To try it without a real model: `pnpm build` in the repository, then `node packages/server/scripts/faux-server.ts`. It prints the server's address and a pairing code for Bo; the simulator and the Mac reach it at that address.

## Push

The server sends to APNs itself, so it needs an APNs key: in the Apple Developer account, Keys → create a key with Apple Push Notifications service, download the `.p8`, and note its key id and your team id. Then in `nudge.json`:

```json
"push": {
  "apns": { "keyFile": "apns-key.p8", "keyId": "ABC123DEFG", "teamId": "XYZ987TEAM", "bundleId": "app.nudge.dev" }
}
```

Builds run from Xcode register as `sandbox` devices and get their pushes through Apple's sandbox; release builds through production. One key serves both. The simulator gets no pushes from APNs.
