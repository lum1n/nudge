import Nudge
import SwiftUI
import UserNotifications

/// The account, the assistant's extensions (for admins), the player's own memory, this month's
/// spend, notifications, and signing out.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let client: NudgeClient
    let account: Account
    @State private var memory: PlayerMemory?
    @State private var usage: Usage?
    @State private var newFact = ""
    @State private var notifications: UNAuthorizationStatus?
    @State private var problem: String?
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Signed in as", value: model.me?.player.displayName ?? "…")
                    LabeledContent("Assistant", value: account.assistantName)
                    LabeledContent("Server", value: account.server)
                }
                if model.me?.admin == true {
                    Section {
                        NavigationLink { ExtensionsView(client: client) } label: {
                            Label("Extensions", systemImage: "puzzlepiece.extension")
                        }
                    } header: {
                        Text("Assistant")
                    } footer: {
                        Text("Turn them on or off and change their settings, for every room.")
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
                Text("You'll need a new pairing code to sign in again.")
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

    private func forget(_ fact: Fact) async {
        await attempt { try await client.forgetForMe(factId: fact.id) }
    }

    private func share(_ shared: Bool) async {
        await attempt { memory = try await client.shareMyMemory(shared: shared) }
    }

    /// Runs a change, then reads the memory again.
    private func attempt(_ change: () async throws -> Void) async {
        do {
            try await change()
            memory = try await client.myMemory()
            problem = nil
        } catch {
            problem = explain(error)
        }
    }
}
