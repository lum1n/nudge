import Nudge
import SwiftUI

#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A new server on exe.dev (ADR 11): the person signs in to exe.dev here (or pastes a token they
/// minted on a computer), names the server, and the app makes it and waits until it can be set up.
/// Then the setup wizard takes its address and setup code.
struct ExeView: View {
    @Environment(AppModel.self) private var model
    let done: () -> Void
    @State private var token = ""
    @State private var name = "nudge"
    @State private var busy = false
    @State private var progress: String?
    @State private var problem: String?
    @State private var launched: SetupStart?
    /// Whether the token came from signing in here, or one kept from before.
    @State private var signedIn = false
    private let command = exeTokenCommand()

    private var vmName: String { slugOf(name).isEmpty ? "nudge" : slugOf(name) }

    var body: some View {
        Form {
            Section {
                Text("Nudge makes a small server in your exe.dev account, billed to it, with an HTTPS address of its own.")
                    .foregroundStyle(.secondary)
            }
            Section {
                if signedIn {
                    Label("Signed in to exe.dev", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
                NavigationLink {
                    ExeLoginView { minted in
                        token = minted
                        signedIn = true
                    }
                } label: {
                    Label(signedIn ? "Sign in again" : "Sign in to exe.dev", systemImage: "person.crop.circle")
                }
                DisclosureGroup("Or paste a token") {
                    Text(command)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                    Button("Copy the command", systemImage: "doc.on.doc") { copy(command) }
                    SecureField("exe.dev token", text: $token)
                        .autocorrectionDisabled()
                }
            } header: {
                Text("1. Sign in to exe.dev")
            } footer: {
                Text("New to exe.dev? Signing in makes your account: it asks for your email and sends a link. The app keeps its key and token on this device; they can make and remove servers, nothing else.")
            }
            Section {
                TextField("Server name", text: $name)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
            } header: {
                Text("2. Name the server")
            } footer: {
                Text("Its address will be https://\(vmName).exe.xyz")
            }
            if let progress {
                Section {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(progress)
                    }
                }
            }
            if let problem {
                Section { Text(problem).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .disabled(busy)
        .navigationTitle("A server on exe.dev")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { done() }.disabled(busy)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Make the server") { Task { await launch() } }
                    .disabled(busy || token.trimmed.isEmpty || slugOf(name).isEmpty)
            }
        }
        .navigationDestination(item: $launched) { start in
            SetupView(start: start, done: done)
        }
        .onAppear {
            if token.isEmpty, let kept = model.servers.exeToken {
                token = kept
                signedIn = true
            }
        }
    }

    private func launch() async {
        busy = true
        problem = nil
        defer {
            busy = false
            progress = nil
        }
        do {
            let exe = ExeClient(token: token.trimmed)
            progress = "Checking the token…"
            _ = try await exe.whoami()
            model.servers.exeToken = token.trimmed
            progress = "Making the server, then waiting for it to start. This takes a minute or two."
            let server = try await exe.launchServer(name: vmName, waitSeconds: 300)
            launched = SetupStart(server: server.vm.url, code: server.code)
        } catch {
            problem = explain(error)
        }
    }

    private func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
