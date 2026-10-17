import Nudge
import SwiftUI

/// Where setup starts: a server's address, and its code when the app knows it, as after exe.dev.
struct SetupStart: Hashable {
    var server = ""
    var code = ""
}

/// A new server, in a sheet of its own: made on exe.dev and then set up, or set up as it is.
enum NewServer: Identifiable {
    case exe
    case setup(SetupStart)

    var id: String {
        switch self {
        case .exe: "exe"
        case .setup(let start): "setup|\(start.server)"
        }
    }
}

struct NewServerView: View {
    @Environment(\.dismiss) private var dismiss
    let start: NewServer

    var body: some View {
        NavigationStack {
            switch start {
            case .exe: ExeView(done: { dismiss() })
            case .setup(let setup): SetupView(start: setup, done: { dismiss() })
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }
}

/// Where people get a key for each provider setup offers.
private let keyPages = [
    "anthropic": URL(string: "https://console.anthropic.com/settings/keys")!,
    "openai": URL(string: "https://platform.openai.com/api-keys")!,
]

/// The setup wizard (ADR 11), as the web's: a server waiting to be set up, its one-time code, a
/// name for the assistant, a model with the person's own key (or a model server found there), and
/// their name. Setting up signs this device in to the server as its owner, and to the new assistant:
/// as the person's home, or joined from it when they are signed in at home already.
struct SetupView: View {
    @Environment(AppModel.self) private var model
    let start: SetupStart
    let done: () -> Void

    private enum Step { case address, code, name, model, you }

    @State private var step: Step
    @State private var server: String
    @State private var code: String
    @State private var info: SetupInfo?
    @State private var name = ""
    @State private var slug: String?
    @State private var provider: String?
    @State private var modelId: String?
    @State private var key = ""
    @State private var you = ""
    @State private var backups = true
    @State private var busy = false
    @State private var problem: String?

    init(start: SetupStart, done: @escaping () -> Void) {
        self.start = start
        self.done = done
        _step = State(initialValue: start.server.isEmpty ? .address : start.code.isEmpty ? .code : .name)
        _server = State(initialValue: start.server)
        _code = State(initialValue: start.code)
    }

    private var assistant: String { slug ?? slugOf(name) }
    private var offered: SetupProvider? { info?.providers.first { $0.id == provider } }
    private var local: SetupLocalServer? { info?.local.first { $0.id == provider } }

    var body: some View {
        Form {
            switch step {
            case .address:
                Section {
                    TextField("https://nudge.example", text: $server)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("Where is the server?")
                } footer: {
                    Text("A server that isn't set up yet prints its address and a setup code when it starts.")
                }
            case .code:
                Section {
                    TextField("XXXX-XXXX-XXXX", text: $code)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                } header: {
                    Text("Its setup code")
                } footer: {
                    Text("The server printed it when it started.")
                }
            case .name:
                Section {
                    TextField("Robin", text: $name)
                } header: {
                    Text("Name your assistant")
                } footer: {
                    Text("What it calls itself. You can change it later.")
                }
                Section {
                    TextField("In its address", text: Binding(get: { assistant }, set: { slug = slugOf($0) }))
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("In its address")
                } footer: {
                    Text("Part of every address of the people here, so this one stays.")
                }
            case .model:
                modelStep
            case .you:
                Section {
                    TextField("Your name", text: $you)
                        #if os(iOS)
                        .textContentType(.name)
                        #endif
                } header: {
                    Text("And you?")
                } footer: {
                    Text("You will be \(name.trimmed.isEmpty ? "the assistant" : name.trimmed)'s first person, its admin, and this server's owner.")
                }
                Section {
                    Toggle("Back up every night, keeping two weeks, beside the data", isOn: $backups)
                }
            }
            if let problem {
                Section { Text(problem).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .disabled(busy)
        .navigationTitle("Set up Nudge")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(isFirstStep ? "Cancel" : "Back") { back() }
                    .disabled(busy)
            }
            ToolbarItem(placement: .confirmationAction) {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Button(step == .you ? "Set up" : "Continue") { next() }
                        .disabled(!ready)
                }
            }
        }
        // A server from exe.dev comes with its address and code: ask it what it offers first.
        .task { if !start.server.isEmpty { await run { try await load() } } }
    }

    @ViewBuilder private var modelStep: some View {
        Section("Choose its model") {
            Picker("Provider", selection: Binding(get: { provider }, set: choose)) {
                ForEach(info?.providers ?? [], id: \.id) { option in
                    VStack(alignment: .leading) {
                        Text(option.name)
                        Text("With your own API key").font(.caption).foregroundStyle(.secondary)
                    }
                    .tag(Optional(option.id))
                }
                ForEach(info?.local ?? [], id: \.id) { option in
                    VStack(alignment: .leading) {
                        Text(option.name)
                        Text("Running on the server; no key").font(.caption).foregroundStyle(.secondary)
                    }
                    .tag(Optional(option.id))
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
        let models = offered.map { $0.models.map { ($0.id, $0.name) } } ?? local.map { $0.models.map { ($0, $0) } } ?? []
        if models.count > 1 {
            Section("Model") {
                Picker("Model", selection: $modelId) {
                    ForEach(models, id: \.0) { option in Text(option.1).tag(Optional(option.0)) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
        }
        if let offered {
            Section {
                SecureField("\(offered.name) API key", text: $key)
                    .autocorrectionDisabled()
                if let page = keyPages[offered.id] {
                    Link("Get a key", destination: page)
                }
            } header: {
                Text("\(offered.name) API key")
            } footer: {
                Text("Kept encrypted on the server, never shown again.")
            }
        }
    }

    private var isFirstStep: Bool {
        switch step {
        case .address: true
        case .code: !start.server.isEmpty
        case .name: !start.code.isEmpty
        case .model, .you: false
        }
    }

    private var ready: Bool {
        switch step {
        case .address: !server.trimmed.isEmpty
        case .code: !code.trimmed.isEmpty
        case .name: !name.trimmed.isEmpty && !assistant.isEmpty
        case .model: provider != nil && modelId != nil && (local != nil || !key.trimmed.isEmpty)
        case .you: !you.trimmed.isEmpty
        }
    }

    private func choose(_ id: String?) {
        provider = id
        if let option = info?.providers.first(where: { $0.id == id }) {
            modelId = option.recommended
        } else {
            modelId = info?.local.first { $0.id == id }?.models.first
        }
    }

    private func back() {
        problem = nil
        if isFirstStep { return done() }
        switch step {
        case .address: done()
        case .code: step = .address
        case .name: step = .code
        case .model: step = .name
        case .you: step = .model
        }
    }

    private func next() {
        Task {
            switch step {
            case .address:
                await run {
                    server = normalizedAddress(server)
                    try await load()
                    step = .code
                }
            case .code:
                await run {
                    try await checkSetupCode(server: server, code: code.trimmed)
                    step = .name
                }
            case .name:
                step = .model
            case .model:
                await run {
                    if local == nil, let provider {
                        try await checkSetupKey(server: server, code: code.trimmed, provider: provider, key: key.trimmed)
                    }
                    step = .you
                }
            case .you:
                await run {
                    guard let provider, let modelId else { return }
                    try await model.setUpServer(
                        server,
                        choices: SetupChoices(
                            code: code.trimmed,
                            assistantName: assistant,
                            displayName: name.trimmed,
                            model: ModelChoice(provider: local?.id ?? provider, modelId: modelId),
                            key: local == nil ? key.trimmed : nil,
                            local: local?.id,
                            yourName: you.trimmed,
                            publicUrl: server,
                            backups: backups))
                    done()
                }
            }
        }
    }

    private func load() async throws {
        let found = try await setupInfo(server: server)
        guard found.open else { throw SetupProblem.setUpAlready }
        info = found
        if provider == nil, let first = found.providers.first {
            provider = first.id
            modelId = first.recommended
        }
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        problem = nil
        defer { busy = false }
        do {
            try await work()
        } catch NudgeError.Status(let status, let detail) {
            problem = switch status {
            case 401: "That isn't the setup code."
            case 410: "Setup closed: the server is set up already, or took too many wrong codes. Restart it for a new code."
            default: detail
            }
        } catch {
            problem = explain(error)
        }
    }
}

private enum SetupProblem: LocalizedError {
    case setUpAlready

    var errorDescription: String? { "That server is set up already: sign in to it instead." }
}

/// An assistant's name as its address has it: lower case, dashes for the rest.
func slugOf(_ name: String) -> String {
    let plain = name.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil).lowercased()
    let dashed = plain.replacing(/[^a-z0-9]+/, with: "-")
    return String(dashed.trimmingCharacters(in: ["-"]).prefix(40))
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
