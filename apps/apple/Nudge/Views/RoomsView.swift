import Nudge
import SwiftUI

/// The player's rooms beside the open one: a sidebar on the Mac and the iPad, a stack on the
/// iPhone. A room's context menu renames it.
struct RoomsView: View {
    @Environment(AppModel.self) private var model
    let client: NudgeClient
    let account: Account
    @State private var creating = false
    @State private var renaming: Room?
    @State private var settings = false
    @State private var problem: String?

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(selection: $model.selectedRoom) {
                if let banner = connectionBanner {
                    Label(banner, systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .glassEffect(in: .capsule)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                ForEach(rooms, id: \.room.id) { room in
                    RoomRow(room: room, me: model.me?.player.id)
                        .tag(room.room.id)
                        .contextMenu {
                            // Only admins rename the lobby.
                            if room.room.kind != .lobby || model.me?.admin == true {
                                Button("Rename…", systemImage: "pencil") { renaming = room.room }
                            }
                        }
                }
                if model.home?.value?.status == .live && rooms.isEmpty {
                    Text("No rooms yet.").foregroundStyle(.secondary)
                }
            }
            .navigationTitle(account.assistantName)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("My room", systemImage: "person") { Task { await openPersonalRoom() } }
                        Button("New shared room…", systemImage: "person.2") { creating = true }
                    } label: {
                        Label("New room", systemImage: "square.and.pencil")
                    }
                }
                ToolbarItem(placement: .navigation) {
                    Button("Settings", systemImage: "gearshape") { settings = true }
                }
            }
            .alert("Couldn't open the room", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") { problem = nil }
            } message: {
                Text(problem ?? "")
            }
            #if os(macOS)
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
            #endif
        } detail: {
            if let room = model.selectedRoom {
                RoomView(client: client, roomId: room, me: model.me?.player.id).id(room)
            } else {
                ContentUnavailableView("Pick a room", systemImage: "bubble.left.and.bubble.right")
            }
        }
        .sheet(isPresented: $creating) {
            NewRoomView(client: client) { model.selectedRoom = $0 }
        }
        .sheet(isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            if let renaming { RenameRoomView(client: client, room: renaming) }
        }
        .sheet(isPresented: $settings) {
            SettingsView(client: client, account: account)
        }
    }

    /// Newest news first.
    private var rooms: [HomeRoom] {
        (model.home?.value?.view?.rooms ?? []).sorted { ($0.lastItemAt ?? 0) > ($1.lastItemAt ?? 0) }
    }

    private var connectionBanner: String? {
        switch model.connection?.value {
        case .waiting?: "Offline. Reconnecting…"
        case .connecting(let attempt)? where attempt > 0: "Reconnecting…"
        case .closed(let code, let reason)? where code != 1000 && code != 4401:
            reason.isEmpty ? "Disconnected (\(code))" : reason
        default: nil
        }
    }

    private func openPersonalRoom() async {
        do {
            model.selectedRoom = try await client.personalRoom().id
        } catch {
            problem = explain(error)
        }
    }
}

struct RoomRow: View {
    let room: HomeRoom
    let me: String?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(.tint).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(room.room.name).lineLimit(1)
                if !others.isEmpty {
                    Text(others).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if room.pendingApprovals > 0 {
                Text("\(room.pendingApprovals)")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .glassEffect(.regular.tint(.orange), in: .capsule)
                    .accessibilityLabel("\(room.pendingApprovals) to approve")
            }
            if room.running {
                ProgressView().controlSize(.small).accessibilityLabel("Answering")
            }
        }
        .padding(.vertical, 2)
    }

    private var icon: String {
        switch room.room.kind {
        case .personal: "person.crop.circle"
        case .shared: "person.2"
        case .lobby: "door.left.hand.open"
        }
    }

    private var others: String {
        room.room.members.filter { $0.id != me }.map(\.displayName).formatted(.list(type: .and))
    }
}

struct NewRoomView: View {
    @Environment(\.dismiss) private var dismiss
    let client: NudgeClient
    let created: (String) -> Void
    @State private var name = ""
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name).onSubmit { Task { await create() } }
                if let problem { Text(problem).foregroundStyle(.red) }
            }
            .formStyle(.grouped)
            .navigationTitle("New shared room")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 160)
        #endif
    }

    private func create() async {
        do {
            let room = try await client.createRoom(name: name.trimmingCharacters(in: .whitespaces), members: [])
            created(room.id)
            dismiss()
        } catch {
            problem = explain(error)
        }
    }
}

/// The room keeps its id; the list shows the new name once the home view has it.
struct RenameRoomView: View {
    @Environment(\.dismiss) private var dismiss
    let client: NudgeClient
    let room: Room
    @State private var name: String
    @State private var problem: String?

    init(client: NudgeClient, room: Room) {
        self.client = client
        self.room = room
        _name = State(initialValue: room.name)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name).onSubmit { Task { await rename() } }
                if let problem { Text(problem).foregroundStyle(.red) }
            }
            .formStyle(.grouped)
            .navigationTitle("Rename room")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Rename") { Task { await rename() } }
                        .disabled(trimmed.isEmpty || trimmed == room.name)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 160)
        #endif
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }

    private func rename() async {
        guard !trimmed.isEmpty, trimmed != room.name else { return }
        do {
            _ = try await client.renameRoom(room: room.id, name: trimmed)
            dismiss()
        } catch {
            problem = explain(error)
        }
    }
}
