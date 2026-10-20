import Nudge
import SwiftUI
import UserNotifications

/// The account, the servers this device owns, the extensions and invites of each assistant the
/// player is an admin of, the player's own memory, this month's spend, notifications, and signing out.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let client: NudgeClient
    let account: Account
    @State private var memory: PlayerMemory?
    @State private var usage: Usage?
    @State private var newFact = ""
    @State private var hidden: [PrivateValue]?
    @State private var newHidden = ""
    @State private var notifications: UNAuthorizationStatus?
    @State private var problem: String?
    @State private var confirmSignOut = false
    @State private var signingOutOf: Session?
    @State private var joiningCluster: Session?
    @State private var leaving: Membership?

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    NavigationLink { ProfileView(client: client) } label: {
                        LabeledContent("Signed in as", value: model.me?.player.displayName ?? "…")
                    }
                    LabeledContent("Assistant", value: account.assistantName)
                    LabeledContent("Server", value: account.server)
                }
                Section {
                    NavigationLink { ServersView(address: model.memberships?.address) } label: {
                        Label(
                            model.servers.owned.isEmpty ? "Servers" : "Servers (\(model.servers.owned.count))",
                            systemImage: "server.rack")
                    }
                } footer: {
                    Text(model.servers.owned.isEmpty
                        ? "Make your own on exe.dev, and assistants on it."
                        : "Yours: their assistants, model keys and updates.")
                }
                if let joined = model.memberships {
                    Section {
                        LabeledContent("Your address") {
                            Text(joined.address).textSelection(.enabled)
                        }
                        ForEach(joined.memberships, id: \.place) { membership in
                            Toggle(isOn: Binding(
                                get: { membership.carryMemory },
                                set: { carry in Task { await change { try await model.carryMemory(membership, carry) } } }
                            )) {
                                VStack(alignment: .leading) {
                                    Text(membership.assistant)
                                    Text("Take my own memory there")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .contextMenu {
                                Button("Leave", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                                    leaving = membership
                                }
                            }
                            .swipeActions {
                                Button("Leave", role: .destructive) { leaving = membership }
                            }
                        }
                    } header: {
                        Text("Other assistants")
                    } footer: {
                        Text("An admin of another assistant invites you by your address; the invite opens here. What only you see stays home.")
                    }
                }
                let standalone = model.places.filter(\.account.isStandalone)
                if !standalone.isEmpty {
                    Section {
                        ForEach(standalone, id: \.account.keychainAccount) { place in
                            LabeledContent(place.account.assistantName, value: place.account.server)
                                .contextMenu {
                                    if model.canJoinCluster(place) {
                                        Button("Join my cluster", systemImage: "point.3.connected.trianglepath.dotted") {
                                            joiningCluster = place
                                        }
                                    }
                                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                                        signingOutOf = place
                                    }
                                }
                                .swipeActions {
                                    Button("Sign out", role: .destructive) { signingOutOf = place }
                                    if model.canJoinCluster(place) {
                                        Button("Join my cluster") { joiningCluster = place }
                                    }
                                }
                        }
                    } header: {
                        Text("On their own")
                    } footer: {
                        Text("Servers outside your cluster, without federation. One set up from your home can join your cluster later, keeping its rooms and history.")
                    }
                }
                if model.me?.admin == true {
                    Section {
                        if let session = model.session {
                            NavigationLink { RobotView(session: session) } label: {
                                Label("Robot", systemImage: "face.smiling")
                            }
                        }
                        NavigationLink { ExtensionsView(client: client) } label: {
                            Label("Extensions", systemImage: "puzzlepiece.extension")
                        }
                        // Without federation at home there are no memberships.
                        if model.memberships != nil {
                            NavigationLink { InvitesView(client: client, assistantName: account.assistantName) } label: {
                                Label("Invites", systemImage: "person.badge.plus")
                            }
                        }
                    } header: {
                        Text("Assistant")
                    } footer: {
                        Text("How the assistant's robot looks to everyone. Turn extensions on or off and change their settings, for every room. Invite someone from another assistant by their address.")
                    }
                }
                // The assistants joined from home where the player is an admin too.
                ForEach(model.places.filter { $0.me?.admin == true }, id: \.account.keychainAccount) { place in
                    Section {
                        NavigationLink { RobotView(session: place) } label: {
                            Label("Robot", systemImage: "face.smiling")
                        }
                        NavigationLink { ExtensionsView(client: place.client) } label: {
                            Label("Extensions", systemImage: "puzzlepiece.extension")
                        }
                        // Invites go through federation, which a standalone assistant hasn't.
                        if !place.account.isStandalone {
                            NavigationLink { InvitesView(client: place.client, assistantName: place.account.assistantName) } label: {
                                Label("Invites", systemImage: "person.badge.plus")
                            }
                        }
                    } header: {
                        Text("\(place.account.assistantName) on \(URL(string: place.account.server)?.host() ?? place.account.server)")
                    }
                }
                Section {
                    if let memory {
                        Toggle("Share with all my rooms", isOn: Binding(
                            get: { memory.shared },
                            set: { shared in Task { await share(shared) } }))
                        ForEach(memory.facts, id: \.id) { fact in
                            Text(fact.text)
                                .contextMenu {
                                    Button("Forget", systemImage: "trash", role: .destructive) {
                                        Task { await forget(fact) }
                                    }
                                }
                        }
                        .onDelete { offsets in
                            for index in offsets { Task { await forget(memory.facts[index]) } }
                        }
                        TextField("Remember…", text: $newFact).onSubmit { Task { await remember() } }
                    } else {
                        ProgressView()
                    }
                } header: {
                    Text("My memory")
                } footer: {
                    Text("Facts about you, shown in your own room. Shared, every room you're in sees them, and the assistant there too.")
                }
                Section {
                    if let hidden {
                        ForEach(hidden, id: \.placeholder) { value in
                            Label(value.value, systemImage: "lock.fill")
                                .contextMenu {
                                    Button("Forget for good", systemImage: "trash", role: .destructive) {
                                        Task { await attempt { try await client.forgetValue(placeholder: value.placeholder) } }
                                    }
                                }
                        }
                        .onDelete { offsets in
                            for index in offsets {
                                Task { await attempt { try await client.forgetValue(placeholder: hidden[index].placeholder) } }
                            }
                        }
                        TextField("Hide a value…", text: $newHidden).onSubmit { Task { await hide() } }
                    } else {
                        ProgressView()
                    }
                } header: {
                    Text("Only you see")
                } footer: {
                    Text("An address, a name or a number: the others and the assistant see it as hidden, in every room. Forgotten, everyone sees only that it was hidden.")
                }
                if let usage {
                    Section("This month") {
                        LabeledContent("Your messages", value: dollars(usage.mine))
                        LabeledContent("Everyone", value: dollars(usage.total))
                        if let limit = usage.perPlayerUsd {
                            LabeledContent("Your limit", value: dollars(limit))
                        }
                        if let limit = usage.monthlyUsd {
                            LabeledContent("Monthly limit", value: dollars(limit))
                        }
                    }
                }
                Section("Speech") {
                    NavigationLink { SpeechView() } label: {
                        LabeledContent("Dictation", value: model.speech.ready ? model.speech.model?.name ?? "" : "Not downloaded")
                    }
                }
                Section {
                    LabeledContent("Notifications", value: notificationsText)
                    if notifications == .notDetermined {
                        Button("Turn on notifications") { Push.requestPermission() }
                    }
                } footer: {
                    Text("Nudge tells you when an answer is ready or an action waits for your approval, while the app is closed.")
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Sign out of \(account.assistantName)?", isPresented: $confirmSignOut) {
                Button("Sign out", role: .destructive) {
                    dismiss()
                    Task { await model.signOut() }
                }
            } message: {
                Text("This device signs out of the assistants you joined from there too. You'll need a new pairing code to sign in again.")
            }
            .confirmationDialog(
                "Leave \(leaving?.assistant ?? "")?",
                isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } })
            ) {
                Button("Leave", role: .destructive) {
                    if let membership = leaving {
                        Task { await change { try await model.leave(membership) } }
                    }
                }
            } message: {
                Text("Your home stops sending it your profile and memory, and this device signs out of it. You stay a member there.")
            }
            .confirmationDialog(
                "Sign out of \(signingOutOf?.account.assistantName ?? "")?",
                isPresented: Binding(get: { signingOutOf != nil }, set: { if !$0 { signingOutOf = nil } })
            ) {
                Button("Sign out", role: .destructive) {
                    if let place = signingOutOf {
                        Task { await model.signOut(of: place) }
                    }
                }
            } message: {
                Text("You'll need a new pairing code from it to sign in again.")
            }
            .confirmationDialog(
                "Join \(joiningCluster?.account.assistantName ?? "") to your cluster?",
                isPresented: Binding(get: { joiningCluster != nil }, set: { if !$0 { joiningCluster = nil } })
            ) {
                Button("Join my cluster") {
                    if let place = joiningCluster {
                        Task { await change { try await model.joinCluster(place) } }
                    }
                }
            } message: {
                Text("It gets federation, and you join it from home as the person you are there now: its rooms and history stay, and your other devices list it.")
            }
            .task { await load() }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private var notificationsText: String {
        switch notifications {
        case .authorized?, .provisional?, .ephemeral?:
            model.pushPlatforms?.apns == true ? "On" : "Not sent by this server"
        case .denied?: "Off in Settings"
        case .notDetermined?: "Not asked yet"
        default: "…"
        }
    }

    private func dollars(_ value: Double) -> String {
        value.formatted(.currency(code: "USD"))
    }

    private func load() async {
        notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        do {
            memory = try await client.myMemory()
            hidden = try await client.privateValues()
            usage = try await client.usage()
        } catch {
            problem = explain(error)
        }
    }

    private func remember() async {
        let text = newFact.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        await attempt {
            _ = try await client.rememberForMe(text: text)
            newFact = ""
        }
    }

    private func hide() async {
        let text = newHidden.trimmingCharacters(in: .whitespaces)
        guard text.count >= 2 else { return }
        await attempt {
            _ = try await client.protect(value: text, kind: nil, private: true)
            newHidden = ""
        }
    }

    private func forget(_ fact: Fact) async {
        await attempt { try await client.forgetForMe(factId: fact.id) }
    }

    private func share(_ shared: Bool) async {
        await attempt { memory = try await client.shareMyMemory(shared: shared) }
    }

    /// Runs a change of the memberships, saying what went wrong.
    private func change(_ action: () async throws -> Void) async {
        do {
            try await action()
            problem = nil
        } catch {
            problem = explain(error)
        }
    }

    /// Runs a change, then reads the memory and the hidden values again.
    private func attempt(_ change: () async throws -> Void) async {
        do {
            try await change()
            memory = try await client.myMemory()
            hidden = try await client.privateValues()
            problem = nil
        } catch {
            problem = explain(error)
        }
    }
}

extension Membership {
    /// The assistant it is at, as one string.
    var place: String { "\(server)|\(assistant)" }
}
