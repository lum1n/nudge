import Nudge
import SwiftUI

/// A pending approval in the room, decided here: what it asks for typed in (a secret one in a
/// secure field), and what the app does first with this device's exe.dev token, such as making a
/// VM. What is typed is only held while the card shows, sent with the yes, and cleared once sent.
/// A failure shows on the card and the approval stays pending, to try again or deny.
struct PendingApprovalCard: View {
    let approval: Approval
    /// Approves with the inputs, or denies; what it throws shows on the card.
    let decide: (_ approve: Bool, _ inputs: [String: String]?) async throws -> Void
    @Environment(AppModel.self) private var model
    @State private var values: [String: String] = [:]
    /// What the client action gave, once it ran: trying again then only approves.
    @State private var actionInputs: [String: String]?
    @State private var hasExeToken = true
    @State private var busy = false
    @State private var progress: String?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Needs approval", systemImage: "hand.raised.fill")
                .font(.caption.bold())
                .foregroundStyle(.orange)
            Text(hidingValues(approval.summary))
            ForEach(approval.inputs, id: \.name) { input in
                VStack(alignment: .leading, spacing: 4) {
                    let label = input.optional ? String(localized: "\(input.label) (optional)") : input.label
                    Group {
                        if input.secret {
                            SecureField(label, text: value(input.name))
                        } else {
                            TextField(label, text: value(input.name))
                        }
                    }
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .disabled(busy)
                    if let description = input.description {
                        Text(description).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if blocked {
                Text("This is done with your exe.dev account. Add your exe.dev token first, under Settings › Servers › Make a server on exe.dev, then come back to approve.")
                    .font(.caption)
            }
            if let problem {
                Text(problem).font(.caption).foregroundStyle(.red)
            }
            if let progress {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(progress).font(.caption)
                }
            }
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button { send(true) } label: {
                        Label(approveTitle, systemImage: approval.clientAction == nil ? "checkmark" : "cloud")
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(busy || missing || blocked)
                    Button("Deny", systemImage: "xmark", role: .destructive) { send(false) }
                        .buttonStyle(.glass)
                        .disabled(busy)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(0.25)), in: .rect(cornerRadius: 22))
        // Again each time it shows: the token may have been added in Settings meanwhile.
        .onAppear { hasExeToken = model.servers.exeToken != nil }
    }

    /// An action on the device, and no exe.dev token here to do it with.
    private var blocked: Bool { approval.clientAction != nil && actionInputs == nil && !hasExeToken }

    /// A required input left empty.
    private var missing: Bool {
        approval.inputs.contains { !$0.optional && (values[$0.name] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private var approveTitle: LocalizedStringKey {
        switch approval.clientAction {
        case .exeNew(let name, _, _)?: "Launch VM \(name)"
        case .exeRm(let name)?: "Delete VM \(name)"
        case nil: "Approve"
        }
    }

    private func value(_ name: String) -> Binding<String> {
        Binding(get: { values[name] ?? "" }, set: { values[name] = $0 })
    }

    private func send(_ approve: Bool) {
        guard !busy else { return }
        busy = true
        problem = nil
        Task {
            defer {
                busy = false
                progress = nil
            }
            do {
                guard approve else {
                    try await decide(false, nil)
                    return
                }
                var inputs = values.filter { !$0.value.isEmpty }
                if let action = approval.clientAction {
                    if actionInputs == nil {
                        guard let token = model.servers.exeToken else {
                            hasExeToken = false
                            return
                        }
                        progress = switch action {
                        case .exeNew: String(localized: "Making the VM…")
                        case .exeRm: String(localized: "Deleting the VM…")
                        }
                        actionInputs = try await ExeClient(token: token).runClientAction(action: action)
                    }
                    inputs.merge(actionInputs ?? [:]) { _, done in done }
                }
                progress = String(localized: "Approving…")
                // Sent once, then gone from here, whatever the answer.
                defer { values = [:] }
                try await decide(true, inputs.isEmpty ? nil : inputs)
            } catch {
                problem = explain(error)
            }
        }
    }
}
