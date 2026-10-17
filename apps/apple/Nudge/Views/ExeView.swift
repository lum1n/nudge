import Nudge
import SwiftUI

#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A new server on exe.dev (ADR 11): the person runs one command to mint a token for the app, which
/// keeps it in the keychain, names the server, and the app makes it and waits until it can be set
/// up. Then the setup wizard takes its address and setup code.
struct ExeView: View {
    @Environment(AppModel.self) private var model
    let done: () -> Void
    @State private var token = ""
    @State private var name = "nudge"
    @State private var busy = false
    @State private var progress: String?
    @State private var problem: String?
    @State private var launched: SetupStart?
    private let command = exeTokenCommand()

    private var vmName: String { slugOf(name).isEmpty ? "nudge" : slugOf(name) }

    var body: some View {
        Form {
            Section {
                Text("Nudge makes a small server in your exe.dev account, billed to it, with an HTTPS address of its own.")
                    .foregroundStyle(.secondary)
            }
            Section {
                Text(command)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                Button("Copy the command", systemImage: "doc.on.doc") { copy(command) }
                SecureField("exe.dev token", text: $token)
                    .autocorrectionDisabled()
            } header: {
                Text("1. Give the app a token")
            } footer: {
                Text("Run this once on a computer with your exe.dev key, and paste what it prints. It stays on this device. It can make and remove servers, nothing else.")
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
        .onAppear { if token.isEmpty { token = model.servers.exeToken ?? "" } }
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
