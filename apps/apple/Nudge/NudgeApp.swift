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
        .onChange(of: model.pendingLink) { _, link in
            if model.client != nil { switching = link }
        }
        .sheet(item: $switching) { link in
            SwitchAccountView(link: link)
        }
        .sheet(item: Binding(
            get: { model.session == nil ? nil : model.pendingJoin },
            set: { model.pendingJoin = $0 }
        )) { link in
            JoinView(link: link)
        }
        .sheet(item: Binding(
            get: { model.session == nil ? nil : model.pendingSignIn },
            set: { model.pendingSignIn = $0 }
        )) { link in
            SignInBrowserView(link: link)
        }
    }
}

/// The web UI's sign-in page showed a QR code: sign that browser in as the player.
struct SignInBrowserView: View {
    @Environment(AppModel.self) private var model
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
        model.pendingSignIn = nil
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
                        model.pendingJoin = nil
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
            model.pendingJoin = nil
            dismiss()
        } catch {
            problem = explain(error)
        }
    }
}
