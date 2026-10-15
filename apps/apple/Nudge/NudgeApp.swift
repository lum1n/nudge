import Nudge
import SwiftUI

@main
struct NudgeApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #else
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #endif
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(delegate.model)
                .onOpenURL { delegate.model.handle($0) }
        }
        .onChange(of: scenePhase) { _, phase in
            delegate.model.setActive(phase != .background)
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }
}

/// Sign-in until there is an account; then the rooms.
struct RootView: View {
    @Environment(AppModel.self) private var model
    /// A pairing link opened while signed in: ask before switching.
    @State private var switching: PairingLink?

    var body: some View {
        Group {
            if let client = model.client, let account = model.account {
                RoomsView(client: client, account: account)
            } else {
                SignInView()
            }
        }
        .onChange(of: model.connection?.value) { _, status in
            // The token was revoked or is unknown: nothing will work until signing in again.
            if case .closed(code: 4401, _) = status {
                Task { await model.signOut(because: "This device was signed out. Ask for a new pairing code.") }
            }
        }
        .onChange(of: model.pendingLink) { _, link in
            if model.client != nil { switching = link }
        }
        .sheet(item: $switching) { link in
            SwitchAccountView(link: link)
        }
    }
}
