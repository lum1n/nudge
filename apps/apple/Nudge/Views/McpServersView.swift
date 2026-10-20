import Nudge
import SwiftUI

/// The MCP servers the room's assistant can use. People ask for one in the chat; here they set
/// what only people set: keys and sign-ins (the assistant never sees them), and which calls wait
/// for approval.
struct McpServersView: View {
    @Environment(AppModel.self) private var model
    let client: NudgeClient
    let roomId: String
    @State private var servers: ObservedMcpServers?
    @State private var openingError: String?
    @State private var removing: McpServer?

    var body: some View {
        content
            .navigationTitle("MCP servers")
            .confirmationDialog(
                "Remove \(removing?.name ?? "")?",
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
            ) {
                Button("Remove", role: .destructive) {
                    if let removing { servers?.remove(removing) }
                }
            } message: {
                Text("The assistant can't use it any more, and its keys and sign-in are forgotten.")
            }
            .onAppear {
                guard servers == nil else { return }
                do {
                    servers = try client.observeMcpServers(roomId)
                } catch {
                    openingError = explain(error)
                }
            }
            .onDisappear {
                servers?.close()
                servers = nil
            }
    }

    @ViewBuilder private var content: some View {
        let state = servers?.value
        if let openingError {
            ContentUnavailableView("Can't open the MCP servers", systemImage: "exclamationmark.triangle", description: Text(openingError))
        } else if case .closed(let code, _)? = state?.status, code == 4404 {
            ContentUnavailableView(
                "No MCP servers here", systemImage: "server.rack",
                description: Text("Turn on the mcp extension for this room under Room."))
        } else if let all = state?.servers, let servers {
            Form {
                Section {
                    if let error = state?.error {
                        Text(error).foregroundStyle(.red)
                    }
                    if all.isEmpty {
                        Text("No MCP servers yet.").foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("MCP servers this room's assistant can use. Ask it in the chat to add one. Keys and sign-ins go here only: the assistant never sees them.")
                }
                ForEach(all) { server in
                    McpServerSection(server: server, panel: servers, base: base) {
                        removing = server
                    }
                }
            }
            .formStyle(.grouped)
        } else {
            ProgressView()
        }
    }

    /// The address the app reaches the server by, which the sign-in comes back to.
    private var base: String? {
        model.sessions.first { $0.client === client }?.account.server.trimmingCharacters(in: ["/"])
    }
}

private struct McpServerSection: View {
    @Environment(\.openURL) private var openURL
    let server: McpServer
    let panel: ObservedMcpServers
    let base: String?
    let remove: () -> Void
    @State private var signingIn = false
    @State private var problem: String?

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(server.useFor)
                Text(server.runs)
                    .font(server.command == nil ? .caption : .caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Text(server.tools.map { "Added by \(server.addedBy) · \($0) \($0 == 1 ? "tool" : "tools")" } ?? "Added by \(server.addedBy)")
                    .font(.caption).foregroundStyle(.secondary)
                if let problem = server.problem {
                    Text(problem).font(.caption).foregroundStyle(.orange)
                }
            }
            ForEach(server.keys, id: \.name) { key in
                McpKeyRow(key: key, server: server, panel: panel)
            }
            // Remote servers without keys sign in with OAuth, in the browser.
            if server.url != nil && server.keys.isEmpty {
                LabeledContent("Sign-in", value: server.signedIn ? "Signed in" : "Not signed in")
                if !server.signedIn {
                    Text("Servers that need it ask for it.").font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Button(server.signedIn ? "Sign in again" : "Sign in", action: signIn)
                        .disabled(signingIn || base == nil)
                    if server.signedIn {
                        Button("Sign out") { panel.signOut(server) }
                    }
                }
                .buttonStyle(.glass)
                if let problem {
                    Text(problem).foregroundStyle(.red)
                }
            }
            Picker("Approval", selection: Binding(get: { server.approval }, set: { panel.setApproval($0, for: server) })) {
                Text("Ask before calls that change something").tag("writes")
                Text("Ask before every call").tag("always")
                Text("Never ask").tag("never")
            }
            Button("Try again") { panel.refresh(server) }
            Button("Remove", role: .destructive, action: remove)
        } header: {
            Text(server.name)
        }
    }

    private func signIn() {
        guard let base else { return }
        signingIn = true
        Task {
            defer { signingIn = false }
            do {
                if let url = try await panel.signIn(server, base: base) { openURL(url) }
                problem = nil
            } catch {
                problem = explain(error)
            }
        }
    }
}

private struct McpKeyRow: View {
    let key: McpKey
    let server: McpServer
    let panel: ObservedMcpServers
    @State private var value = ""

    var body: some View {
        LabeledContent("\(key.placement == "header" ? "Header" : "Variable") \(key.name)", value: key.set ? "Set" : "Not set")
        // Typed without being shown, and cleared once sent: the key never comes back.
        SecureField(placeholder, text: $value)
            .onSubmit(save)
        HStack {
            Button("Save", action: save)
                .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
            if key.set {
                Button("Clear", role: .destructive) { panel.clearKey(key, of: server) }
            }
        }
        .buttonStyle(.glass)
    }

    private var placeholder: String {
        if key.set { return "Replace it" }
        if let prefix = key.prefix?.trimmingCharacters(in: .whitespaces), !prefix.isEmpty {
            return "Paste it (without \"\(prefix)\")"
        }
        return "Paste it"
    }

    private func save() {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        panel.setKey(trimmed, key, of: server)
        value = ""
    }
}
