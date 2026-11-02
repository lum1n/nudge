import Nudge
import SwiftUI

@main
struct NudgeApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #else
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #endif

    var body: some Scene {
        // A window per room the player opens one in ("Open in New Window"); the first one has none
        // and shows the room list's choice.
        WindowGroup(for: RoomRef.self) { $room in
            RootView(room: $room)
                .environment(delegate.model)
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 700)
        #endif
    }
}

/// Sign-in until there is an account; then the rooms. One per window, with that window's state.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    /// The window's room as its scene keeps it: opening a room shown already brings its window
    /// to the front, and a window the system brings back opens on it.
    @Binding var room: RoomRef?
    @State private var window: WindowState
    /// A pairing link opened while signed in: ask before switching.
    @State private var switching: PairingLink?

    init(room: Binding<RoomRef?>) {
        _room = room
        _window = State(initialValue: WindowState(selectedRoom: room.wrappedValue))
    }

    var body: some View {
        Group {
            if let session = model.session {
                RoomsView(session: session)
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
        .onChange(of: window.pendingLink) { _, link in
            if model.client != nil { switching = link }
        }
        .sheet(item: $switching) { link in
            SwitchAccountView(link: link)
        }
        .sheet(item: Binding(
            get: { model.session == nil ? nil : window.pendingJoin },
            set: { window.pendingJoin = $0 }
        )) { link in
            JoinView(link: link)
        }
        .sheet(item: Binding(
            get: { model.session == nil ? nil : window.pendingSignIn },
            set: { window.pendingSignIn = $0 }
        )) { link in
            SignInBrowserView(link: link)
        }
        // The scene phase is this window's here, inside its hierarchy: the sockets stay open while
        // any window is on screen.
        .onChange(of: scenePhase, initial: true) { _, phase in
            window.phase = phase
            model.register(window)
            model.setActive(model.isActive)
        }
        .onAppear { model.register(window) }
        .onDisappear { model.unregister(window) }
        .onChange(of: window.selectedRoom) { _, selected in room = selected }
        .onOpenURL { model.handle($0, in: window) }
        .environment(window)
    }
}

/// The web UI's sign-in page showed a QR code: sign that browser in as the player.
struct SignInBrowserView: View {
    @Environment(AppModel.self) private var model
    @Environment(WindowState.self) private var window
    @Environment(\.dismiss) private var dismiss
    let link: SignInLink
    @State private var busy = false
    @State private var problem: String?
    @State private var signedIn: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Server", value: URL(string: link.server)?.host() ?? link.server)
                } footer: {
                    if let signedIn {
                        Text("The browser is signed in to \(signedIn) as you.")
                    } else {
                        Text("The browser that shows this code gets signed in as you. Only go on if you opened that page yourself.")
                    }
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(signedIn == nil ? "Sign in on the web?" : "Signed in")
            .toolbar {
                if signedIn == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { close() }
                            .disabled(busy)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(problem == nil ? "Sign in" : "Try again") { Task { await approve() } }
                            .disabled(busy)
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { close() }
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 200)
        #endif
    }

    private func close() {
        window.pendingSignIn = nil
        dismiss()
    }

    private func approve() async {
        busy = true
        defer { busy = false }
        do {
            signedIn = try await model.approveSignIn(link)
            problem = nil
        } catch {
            problem = explain(error)
        }
    }
}

/// An admin of another assistant invited the player: join it, the home vouching for them.
struct JoinView: View {
    @Environment(AppModel.self) private var model
    @Environment(WindowState.self) private var window
    @Environment(\.dismiss) private var dismiss
    let link: JoinLink
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Assistant", value: link.assistant)
                    LabeledContent("Server", value: URL(string: link.server)?.host() ?? link.server)
                } footer: {
                    Text("\(model.account?.assistantName ?? "Your home") tells it who you are: your name, picture, time zone and language. Its rooms show up beside your own.")
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Join \(link.assistant)?")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        window.pendingJoin = nil
                        dismiss()
                    }
                    .disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(problem == nil ? "Join" : "Try again") { Task { await join() } }
                        .disabled(busy)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 240)
        #endif
    }

    private func join() async {
        busy = true
        defer { busy = false }
        do {
            try await model.join(link)
            window.pendingJoin = nil
            dismiss()
        } catch {
            problem = explain(error)
        }
    }
}
