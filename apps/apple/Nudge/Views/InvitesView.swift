import Nudge
import SwiftUI

/// People from other assistants an admin lets join this one, by their address: the open invites,
/// a new one, and the link to send the person, which opens in their app.
struct InvitesView: View {
    let client: NudgeClient
    let assistantName: String
    @State private var invites: [Invite]?
    @State private var address = ""
    @State private var made: InviteLink?
    @State private var loadProblem: String?
    @State private var problem: String?

    var body: some View {
        content
            .navigationTitle("Invites")
            .task { await load() }
    }

    @ViewBuilder private var content: some View {
        if let loadProblem {
            ContentUnavailableView("Can't invite", systemImage: "at", description: Text(loadProblem))
        } else {
            Form {
                Section {
                    TextField("ann@nudge.example.com/robin", text: $address)
                        .textContentType(.emailAddress)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        #endif
                        .onSubmit { Task { await invite() } }
                    if let made, let link = URL(string: made.link) {
                        ShareLink(item: link, message: Text("Join \(assistantName) on Nudge")) {
                            Label("Send the invite for \(made.invite.address)", systemImage: "square.and.arrow.up")
                        }
                    }
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    }
                } header: {
                    Text("Their address")
                } footer: {
                    Text("They find it in Settings of their app. The invite works for seven days; send them the link.")
                }
                Section("Waiting to join") {
                    if let invites {
                        if invites.isEmpty {
                            Text("No open invites").foregroundStyle(.secondary)
                        }
                        ForEach(invites, id: \.id) { invite in
                            VStack(alignment: .leading) {
                                Text(invite.address)
                                Text("Until \(Date(timeIntervalSince1970: invite.expiresAt / 1000).formatted(date: .abbreviated, time: .shortened))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .contextMenu {
                                Button("Cancel the invite", systemImage: "xmark", role: .destructive) {
                                    Task { await cancel(invite) }
                                }
                            }
                            .swipeActions {
                                Button("Cancel", role: .destructive) { Task { await cancel(invite) } }
                            }
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    private func load() async {
        do {
            invites = try await client.invites()
        } catch NudgeError.Status(404, _) {
            loadProblem = "This assistant doesn't let people from other assistants join."
        } catch {
            loadProblem = explain(error)
        }
    }

    private func invite() async {
        let text = address.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        await change {
            made = try await client.invite(address: text)
            address = ""
        }
    }

    private func cancel(_ invite: Invite) async {
        await change {
            try await client.cancelInvite(id: invite.id)
            if made?.invite.id == invite.id { made = nil }
        }
    }

    /// Runs a change, then reads the invites again.
    private func change(_ action: () async throws -> Void) async {
        do {
            try await action()
            invites = try await client.invites()
            problem = nil
        } catch {
            problem = explain(error)
        }
    }
}
