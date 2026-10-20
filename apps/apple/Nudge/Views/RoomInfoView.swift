import Nudge
import SwiftUI

/// About a room: its lists, documents, connectors, MCP servers, browser and desktop, who is in it,
/// what the assistant remembers here, its nudges, which extensions it uses, and what the model saw.
struct RoomInfoView: View {
    @Environment(\.dismiss) private var dismiss
    let client: NudgeClient
    let roomId: String
    /// The room's view, kept by the room screen.
    let observed: ObservedRoom?
    @State private var extensions: [RoomExtension]?
    @State private var newFact = ""
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                // The panels of the extensions the room has on.
                let on = Set((extensions ?? []).filter(\.enabled).map(\.name))
                if !on.isDisjoint(with: ["lists", "documents", "connectors", "mcp", "browser", "desktop"]) {
                    Section("In this room") {
                        if on.contains("lists") {
                            NavigationLink { ListsView(client: client, roomId: roomId) } label: {
                                Label("Lists", systemImage: "checklist")
                            }
                        }
                        if on.contains("documents") {
                            NavigationLink { DocumentsView(client: client, roomId: roomId) } label: {
                                Label("Documents", systemImage: "doc.text")
                            }
                        }
                        if on.contains("connectors") {
                            NavigationLink { ConnectorsView(client: client, roomId: roomId) } label: {
                                Label("Connectors", systemImage: "point.3.connected.trianglepath.dotted")
                            }
                        }
                        if on.contains("mcp") {
                            NavigationLink { McpServersView(client: client, roomId: roomId) } label: {
                                Label("MCP servers", systemImage: "server.rack")
                            }
                        }
                        if on.contains("browser") {
                            NavigationLink { BrowserView(client: client, roomId: roomId) } label: {
                                Label("Browser", systemImage: "globe")
                            }
                        }
                        if on.contains("desktop") {
                            NavigationLink { DesktopView(client: client, roomId: roomId) } label: {
                                Label("Desktop", systemImage: "desktopcomputer")
                            }
                        }
                    }
                }
                if let room = state?.room {
                    Section("Members") {
                        ForEach(room.members, id: \.id) { Text($0.displayName) }
                    }
                }
                Section {
                    ForEach(state?.memory ?? [], id: \.id) { fact in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fact.text)
                            if let source = source(of: fact) {
                                Text(source).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .contextMenu {
                            Button("Forget", systemImage: "trash", role: .destructive) { forget(fact) }
                        }
                        .swipeActions {
                            Button("Forget", role: .destructive) { forget(fact) }
                        }
                    }
                    TextField("Remember…", text: $newFact).onSubmit(remember)
                } header: {
                    Text("Memory")
                } footer: {
                    Text("What the assistant knows in this room.")
                }
                if let nudges = state?.nudges, !nudges.isEmpty {
                    Section("Nudges") {
                        ForEach(nudges, id: \.id) { nudge in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(nudge.message)
                                    Text(date(nudge.fireAt), format: .dateTime.weekday().day().month().hour().minute())
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Cancel", role: .destructive) { cancel(nudge) }
                                    .buttonStyle(.glass)
                                    .controlSize(.small)
                            }
                        }
                    }
                }
                Section {
                    if let extensions {
                        ForEach(extensions, id: \.name) { ext in
                            Toggle(isOn: Binding(get: { ext.enabled }, set: { set(ext, $0) })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ext.name)
                                    if let description = ext.description {
                                        Text(description).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    } else {
                        ProgressView()
                    }
                } header: {
                    Text("Extensions")
                }
                Section {
                    NavigationLink("What the model saw") {
                        ModelView(client: client, roomId: roomId)
                    }
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(state?.room?.name ?? "Room")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await loadExtensions() }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private var state: RoomState? { observed?.value }

    private func source(of fact: Fact) -> String? {
        if let owner = fact.owner { return "\(owner.displayName)'s own" }
        if let by = fact.by { return "Added by \(by.displayName)" }
        return nil
    }

    private func loadExtensions() async {
        do {
            extensions = try await client.roomExtensions(room: roomId)
        } catch {
            problem = explain(error)
        }
    }

    private func remember() {
        let text = newFact.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        newFact = ""
        // The room's view brings the fact.
        run { _ = try await client.remember(room: roomId, text: text) }
    }

    private func forget(_ fact: Fact) {
        run { try await client.forget(room: roomId, factId: fact.id) }
    }

    private func cancel(_ nudge: RoomNudge) {
        run { try await client.cancelNudge(nudgeId: nudge.id) }
    }

    private func set(_ ext: RoomExtension, _ enabled: Bool) {
        run {
            let changed = try await client.setRoomExtension(room: roomId, extension: ext.name, enabled: enabled)
            extensions = extensions?.map { $0.name == changed.name ? changed : $0 }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
                problem = nil
            } catch {
                problem = explain(error)
            }
        }
    }
}

/// The room's conversation as the model got it: placeholders where private values were.
struct ModelView: View {
    let client: NudgeClient
    let roomId: String
    @State private var messages: [ModelMessage]?
    @State private var problem: String?

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(.red) }
            ForEach(Array((messages ?? []).enumerated()), id: \.offset) { _, message in
                VStack(alignment: .leading, spacing: 4) {
                    Text(role(message.role)).font(.caption.bold()).foregroundStyle(.secondary)
                    Text(message.text).font(.callout.monospaced()).textSelection(.enabled)
                }
            }
        }
        .overlay { if messages == nil && problem == nil { ProgressView() } }
        .navigationTitle("What the model saw")
        .task {
            do {
                messages = try await client.modelView(room: roomId)
            } catch {
                problem = explain(error)
            }
        }
    }

    private func role(_ role: ModelRole) -> String {
        switch role {
        case .system: "System"
        case .user: "Messages"
        case .assistant: "Assistant"
        case .toolResult: "Tool result"
        }
    }
}
