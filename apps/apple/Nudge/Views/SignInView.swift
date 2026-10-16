import Nudge
import SwiftUI

/// Pairing: the server's address, which assistant, and the one-time code an admin made with
/// `nudge pair <player>`. A `nudge://pair` link fills all three.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var server = ""
    @State private var code = ""
    @State private var assistants: [Assistant] = []
    @State private var assistant: String?
    @State private var looking = false
    @State private var signingIn = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                if let reason = model.signedOutBecause {
                    Section { Label(reason, systemImage: "exclamationmark.triangle") }
                }
                Section {
                    TextField("https://nudge.example", text: $server)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit { Task { await findAssistants() } }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Where your Nudge runs.")
                }
                if !assistants.isEmpty {
                    Section("Assistant") {
                        Picker("Assistant", selection: $assistant) {
                            ForEach(assistants, id: \.name) { assistant in
                                Text(assistant.displayName).tag(Optional(assistant.name))
                            }
                        }
                        #if os(iOS)
                        .pickerStyle(.inline)
                        #endif
                        .labelsHidden()
                    }
                }
                Section {
                    TextField("XXXX-XXXX", text: $code)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                        .onSubmit { Task { await signIn() } }
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("Ask whoever runs the server for one: `nudge pair <your name>`. It works once, for ten minutes. A token (`nudge_…`) works here too.")
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .safeAreaBar(edge: .bottom) {
                Button {
                    Task { await signIn() }
                } label: {
                    HStack {
                        if signingIn || looking { ProgressView().controlSize(.small) }
                        Text("Sign in")
                    }
                    .frame(maxWidth: 420)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.extraLarge)
                .disabled(signingIn || server.isEmpty || code.isEmpty)
                .padding()
            }
            .navigationTitle("Nudge")
            .onChange(of: server) { assistants = []; assistant = nil }
            .task(id: model.pendingLink) { await fill(from: model.pendingLink) }
        }
        #if os(macOS)
        .frame(minWidth: 420, idealWidth: 480, minHeight: 440)
        #endif
    }

    private func fill(from link: PairingLink?) async {
        guard let link else { return }
        server = link.server
        code = link.code
        await findAssistants()
        if assistants.contains(where: { $0.name == link.assistant }) { assistant = link.assistant }
        model.pendingLink = nil
    }

    private func findAssistants() async {
        let address = normalized(server)
        guard !address.isEmpty else { return }
        looking = true
        defer { looking = false }
        do {
            let found = try await listAssistants(server: address)
            // Typing on may have changed the address meanwhile.
            guard normalized(server) == address else { return }
            assistants = found
            if assistant == nil || !found.contains(where: { $0.name == assistant }) {
                assistant = found.first?.name
            }
            problem = found.isEmpty ? "That server has no assistants." : nil
        } catch {
            problem = explain(error)
        }
    }

    private func signIn() async {
        if assistants.isEmpty { await findAssistants() }
        guard let chosen = assistants.first(where: { $0.name == assistant }) else { return }
        signingIn = true
        defer { signingIn = false }
        do {
            try await model.signIn(server: normalized(server), assistant: chosen, code: code)
            problem = nil
        } catch {
            problem = explain(error)
        }
    }

    /// `nudge.example` → `https://nudge.example`, `192.168.1.10:8787` → `http://192.168.1.10:8787`
    /// (a server on the local network rarely has a certificate), and no trailing slash.
    private func normalized(_ text: String) -> String {
        var address = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if address.isEmpty { return address }
        if !address.contains("://") { address = (isLocal(address) ? "http://" : "https://") + address }
        while address.hasSuffix("/") { address.removeLast() }
        return address
    }

    /// Whether an address without a scheme names a host on this network.
    private func isLocal(_ address: String) -> Bool {
        var host = String(address.prefix { $0 != "/" })
        if host.hasPrefix("[") { return host.hasPrefix("[fd") || host.hasPrefix("[fc") || host.hasPrefix("[fe80") || host.hasPrefix("[::1]") }
        if let colon = host.lastIndex(of: ":") { host = String(host[..<colon]) }
        host = host.lowercased()
        if host == "localhost" || [".local", ".lan", ".home.arpa", ".internal"].contains(where: host.hasSuffix) {
            return true
        }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (10, _), (127, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        case (100, 64...127): return true  // carrier-grade NAT, such as Tailscale
        default: return false
        }
    }
}

/// A pairing link opened while signed in somewhere: sign out there, and the sign-in screen
/// takes the link.
struct SwitchAccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let link: PairingLink

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Server", value: link.server)
                    LabeledContent("Assistant", value: link.assistant)
                } footer: {
                    Text("To use this link, this device signs out of \(model.account?.assistantName ?? "the current assistant") first.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Sign in with link?")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        model.pendingLink = nil
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sign out") {
                        dismiss()
                        Task { await model.signOut() }
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 220)
        #endif
    }
}
