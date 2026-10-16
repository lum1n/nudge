import Nudge
import SwiftUI

/// The APIs the room's assistant can call. People ask for one in the chat; here they set what
/// only people set: API keys (the assistant never sees them), the local network, and the calls that
/// only read.
struct ConnectorsView: View {
    let client: NudgeClient
    let roomId: String
    @State private var connectors: ObservedConnectors?
    @State private var openingError: String?
    @State private var removing: Connector?

    var body: some View {
        content
            .navigationTitle("Connectors")
            .confirmationDialog(
                "Remove \(removing?.name ?? "")?",
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
            ) {
                Button("Remove", role: .destructive) {
                    if let removing { connectors?.remove(removing) }
                }
            } message: {
                Text("The assistant can't call it any more, and its API key is forgotten.")
            }
            .onAppear {
                guard connectors == nil else { return }
                do {
                    connectors = try client.observeConnectors(roomId)
                } catch {
                    openingError = explain(error)
                }
            }
            .onDisappear {
                connectors?.close()
                connectors = nil
            }
    }

    @ViewBuilder private var content: some View {
        let state = connectors?.value
        if let openingError {
            ContentUnavailableView("Can't open the connectors", systemImage: "exclamationmark.triangle", description: Text(openingError))
        } else if case .closed(let code, _)? = state?.status, code == 4404 {
            ContentUnavailableView(
                "No connectors here", systemImage: "point.3.connected.trianglepath.dotted",
                description: Text("Turn on the connectors extension for this room under Room."))
        } else if let all = state?.connectors, let connectors {
            Form {
                Section {
                    if let error = state?.error {
                        Text(error).foregroundStyle(.red)
                    }
                    if all.isEmpty {
                        Text("No connectors yet.").foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("APIs this room's assistant can call. Ask it in the chat to add one. API keys go here only: the assistant never sees them.")
                }
                ForEach(all) { connector in
                    ConnectorSection(connector: connector, panel: connectors, admin: state?.admin == true) {
                        removing = connector
                    }
                }
            }
            .formStyle(.grouped)
        } else {
            ProgressView()
        }
    }
}

private struct ConnectorSection: View {
    let connector: Connector
    let panel: ObservedConnectors
    let admin: Bool
    let remove: () -> Void
    @State private var key = ""
    @State private var readPaths = ""

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(connector.useFor)
                Text("\(connector.id) · \(connector.baseUrl)").font(.caption).foregroundStyle(.secondary)
                if !connector.notes.isEmpty {
                    Text("Learned: \(connector.notes)").font(.caption).foregroundStyle(.secondary)
                }
            }
            if connector.shared {
                LabeledContent("Shared with every room", value: "")
            } else {
                if let auth = connector.auth {
                    LabeledContent("API key (\(auth.placement) \(auth.name))", value: connector.hasKey ? "Set" : "Not set")
                    // Typed without being shown, and cleared once sent: the key never comes back.
                    SecureField(connector.hasKey ? "Replace the key" : "Paste the key", text: $key)
                        .onSubmit(saveKey)
                    HStack {
                        Button("Save key", action: saveKey)
                            .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
                        if connector.hasKey {
                            Button("Clear", role: .destructive) { panel.clearKey(of: connector) }
                        }
                    }
                    .buttonStyle(.glass)
                }
                Toggle(isOn: Binding(get: { connector.allowPrivateNetwork }, set: { panel.allowPrivateNetwork($0, for: connector) })) {
                    Text("Local network")
                    Text("May reach this machine and the local network, such as Home Assistant or a NAS")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Calls that only read, though not GET: one METHOD /path per line, such as POST /graphql. They run without asking.")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("POST /graphql", text: $readPaths, axis: .vertical)
                        .font(.callout.monospaced())
                        .lineLimit(2...8)
                        .autocorrectionDisabled()
                    Button("Save read paths") { panel.setReadPaths(lines(readPaths), for: connector) }
                        .buttonStyle(.glass)
                        .disabled(lines(readPaths) == connector.readPaths)
                }
            }
            if admin {
                Button(connector.shared ? "Stop sharing with every room" : "Share with every room") {
                    if connector.shared { panel.unshare(connector) } else { panel.share(connector) }
                }
            }
            if !connector.shared {
                Button("Remove", role: .destructive, action: remove)
            }
        } header: {
            Text(connector.name)
        }
        .onAppear { readPaths = connector.readPaths.joined(separator: "\n") }
        .onChange(of: connector.readPaths) { readPaths = connector.readPaths.joined(separator: "\n") }
    }

    private func saveKey() {
        let value = key.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return }
        panel.setKey(value, for: connector)
        key = ""
    }

    private func lines(_ text: String) -> [String] {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}
