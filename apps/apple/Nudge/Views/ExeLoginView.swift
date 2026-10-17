import Nudge
import SwiftUI

/// The terminal's size: wide enough for exe.dev's banner, small enough to read on a phone.
private let columns: UInt16 = 54
private let rows: UInt16 = 16

/// Signing in to exe.dev on the device (ADR 11): `ssh exe.dev` with the app's own key, its screen
/// shown and what the person types sent. exe.dev asks for their email and mails a link that adds
/// the key to their account, new or not; meanwhile the app tries a token signed with that key until
/// exe.dev takes it, and keeps it.
struct ExeLoginView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let signedIn: (String) -> Void
    @State private var login = ExeSignIn()
    @State private var typed = ""

    var body: some View {
        Form {
            Section {
                GeometryReader { geometry in
                    Text(login.screen.isEmpty ? "Connecting to exe.dev…" : login.screen)
                        .font(.system(size: geometry.size.width / (CGFloat(columns) * 0.61), design: .monospaced))
                        .lineLimit(Int(rows), reservesSpace: true)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .textSelection(.enabled)
                }
                .frame(minHeight: 260)
                HStack {
                    TextField("Your email, or what exe.dev asks", text: $typed)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit(send)
                    Button("Send", systemImage: "return", action: send)
                        .labelStyle(.iconOnly)
                        .disabled(login.ended != nil)
                }
            } footer: {
                Text("exe.dev asks for your email and sends you a link. Open it, then come back: the app is signed in once exe.dev has your key.")
            }
            if let ended = login.ended {
                Section {
                    Text(ended).foregroundStyle(.secondary)
                    Button("Start again") { Task { await login.start(model.servers) } }
                }
            }
            if let problem = login.problem {
                Section { Text(problem).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Sign in to exe.dev")
        .task {
            await login.start(model.servers)
            if let token = await login.waitForToken(model.servers) {
                signedIn(token)
                dismiss()
            }
        }
        .onDisappear { login.close() }
    }

    private func send() {
        let text = typed.trimmed
        guard !text.isEmpty else { return }
        login.send(text + "\r")
        typed = ""
    }
}

/// One sign-in: the session's screen as it changes, and how it ended.
@MainActor @Observable
private final class ExeSignIn {
    var screen = ""
    /// Why the session is over, once it is.
    var ended: String?
    var problem: String?
    @ObservationIgnored private var session: ExeLogin?

    func start(_ servers: Servers) async {
        close()
        ended = nil
        problem = nil
        screen = ""
        do {
            session = try await ExeLogin.start(
                privateKey: try servers.exeKey(), cols: columns, rows: rows, listener: Relay(self))
        } catch {
            ended = "Couldn't connect to exe.dev."
            problem = explain(error)
        }
    }

    func send(_ text: String) {
        session?.send(text: text)
    }

    func close() {
        session?.end()
        session = nil
    }

    /// Tries the token every few seconds until exe.dev takes it, or the view goes. The key's link
    /// may be opened while the app is in the background, so this doesn't wait for the session.
    func waitForToken(_ servers: Servers) async -> String? {
        guard let key = try? servers.exeKey(), let token = try? exeMintToken(privateKey: key, days: 365) else {
            problem = "Couldn't make the exe.dev token."
            return nil
        }
        let exe = ExeClient(token: token)
        while !Task.isCancelled {
            if (try? await exe.whoami()) != nil {
                servers.exeToken = token
                close()
                return token
            }
            try? await Task.sleep(for: .seconds(3))
        }
        return nil
    }

    /// The library calls back on its own threads.
    private final class Relay: ExeLoginListener, @unchecked Sendable {
        weak var login: ExeSignIn?

        init(_ login: ExeSignIn) { self.login = login }

        func onScreen(text: String) {
            Task { @MainActor [weak self] in self?.login?.screen = text }
        }

        func onClosed(problem: String?) {
            Task { @MainActor [weak self] in
                self?.login?.ended = "exe.dev ended the session."
                if let problem { self?.login?.problem = problem }
            }
        }
    }
}
