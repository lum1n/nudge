import Nudge
import SwiftUI

/// The model a provider's new assistant starts with, until the owner picks another.
private let defaultModels = ["anthropic": "claude-sonnet-5", "openai": "gpt-6.1-sol"]

/// How a provider is written, for the ones people know by name.
private func providerName(_ id: String) -> String {
    ["anthropic": "Anthropic", "openai": "OpenAI"][id] ?? id.prefix(1).uppercased() + id.dropFirst()
}

private func host(_ server: String) -> String {
    URL(string: server)?.host() ?? server
}

/// The servers this device owns (ADR 11), and making another on exe.dev.
struct ServersView: View {
    @Environment(AppModel.self) private var model
    /// The player's address at home, to join new assistants from there.
    let address: String?
    @State private var newServer: NewServer?

    var body: some View {
        Form {
            if !model.servers.owned.isEmpty {
                Section("Yours") {
                    ForEach(model.servers.owned, id: \.self) { server in
                        NavigationLink { ServerView(server: server, address: address) } label: {
                            Label(host(server), systemImage: "server.rack")
                        }
                    }
                }
            }
            Section {
                Button("Make a server on exe.dev", systemImage: "cloud") { newServer = .exe }
            } header: {
                Text("New")
            } footer: {
                Text("A small server in your exe.dev account, with an HTTPS address.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Servers")
        .sheet(item: $newServer) { NewServerView(start: $0) }
    }
}

/// One server: its updates, its assistants, the model keys set on it, its Tailscale and Wired, and its
/// recovery kit; removing it, for one made on exe.dev.
private struct ServerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let server: String
    let address: String?
    @State private var info: ServerInfo?
    @State private var keys: [ProviderKey] = []
    @State private var problem: String?
    @State private var settingKey: String?
    @State private var newKey = ""
    @State private var askingPassphrase = false
    @State private var passphrase = ""
    @State private var kit: String?
    @State private var removing = false
    @State private var confirm = ""

    var body: some View {
        Form {
            if let problem {
                Section { Text(problem).foregroundStyle(.red) }
            }
            if let info {
                Section("Assistants") {
                    ForEach(info.assistants, id: \.name) { assistant in
                        NavigationLink {
                            AssistantView(server: server, assistant: assistant, changed: reload)
                        } label: {
                            VStack(alignment: .leading) {
                                Text(assistant.settings.displayName)
                                Text(assistant.running ? assistantNote(assistant) : "Not running: check the server's log")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    NavigationLink {
                        NewAssistantView(server: server, keys: keys, address: address, changed: reload)
                    } label: {
                        Label("New assistant", systemImage: "plus")
                    }
                }
                TailscaleSection(server: server)
                WiredSection(server: server)
                Section("Model keys") {
                    ForEach(keys, id: \.provider) { key in
                        Button {
                            if key.source != .env { settingKey = key.provider }
                        } label: {
                            VStack(alignment: .leading) {
                                Text(providerName(key.provider)).foregroundStyle(.primary)
                                Text(keySource(key)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(key.source == .env)
                    }
                }
                Section("Server") {
                    if let updates = info.updates {
                        Toggle(isOn: Binding(
                            get: { updates.automatic },
                            set: { on in Task { await act { _ = try await model.servers.client(server).setUpdates(automatic: on) } } }
                        )) {
                            VStack(alignment: .leading) {
                                Text("Update automatically")
                                Text("Version \(updates.current). " + (updates.error ?? updates.available.map { "\($0) is out" } ?? "Installs new releases itself"))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button { askingPassphrase = true } label: {
                        VStack(alignment: .leading) {
                            Label("Recovery kit", systemImage: "lock")
                            Text("The backup key, sealed with a passphrase").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let kit {
                        ShareLink(item: kit, subject: Text("Nudge recovery kit for \(host(server))")) {
                            Label("Keep the recovery kit", systemImage: "square.and.arrow.up")
                        }
                    }
                }
                Section {
                    Button("Sign out as owner", role: .destructive) {
                        Task {
                            await model.servers.forget(server)
                            dismiss()
                        }
                    }
                } footer: {
                    Text("This device stops managing it. Nothing on the server changes.")
                }
                if let vm = exeVmName(server), model.servers.exeToken != nil {
                    Section {
                        Button("Remove this server", role: .destructive) { removing = true }
                    } footer: {
                        Text("Deletes \(vm) from your exe.dev account, with its assistants, their history and the backups on it.")
                    }
                }
            } else if problem == nil {
                ProgressView()
            }
        }
        .formStyle(.grouped)
        .navigationTitle(host(server))
        .task { await act {} }
        .alert(
            "\(providerName(settingKey ?? "")) key",
            isPresented: Binding(get: { settingKey != nil }, set: { if !$0 { settingKey = nil; newKey = "" } })
        ) {
            SecureField("Key", text: $newKey)
            Button("Save") {
                if let provider = settingKey {
                    let entered = newKey.trimmed
                    Task { await act { _ = try await model.servers.client(server).setKey(provider: provider, key: entered, assistant: nil) } }
                }
            }
            .disabled(newKey.trimmed.isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("For every assistant here. Tried once before it is kept.")
        }
        .alert("Recovery kit", isPresented: $askingPassphrase) {
            SecureField("Passphrase, 8 characters or more", text: $passphrase)
            Button("Make it") {
                let entered = passphrase
                passphrase = ""
                Task { await act { kit = try await model.servers.client(server).recoveryKit(passphrase: entered) } }
            }
            .disabled(passphrase.count < 8)
            Button("Cancel", role: .cancel) { passphrase = "" }
        } message: {
            Text("With it and a backup, everything on this server can be brought back. Keep it away from the server, and the passphrase in your password manager.")
        }
        .alert("Remove \(host(server))?", isPresented: $removing) {
            TextField(exeVmName(server) ?? "", text: $confirm)
                .autocorrectionDisabled()
            Button("Remove", role: .destructive) {
                confirm = ""
                Task {
                    do {
                        try await model.removeExeServer(server)
                        dismiss()
                    } catch {
                        problem = explain(error)
                    }
                }
            }
            .disabled(confirm.trimmed != exeVmName(server))
            Button("Cancel", role: .cancel) { confirm = "" }
        } message: {
            Text("Everything on it goes for good, and nothing is kept: make a recovery kit and download a backup first if you need one. Type \(exeVmName(server) ?? "") to remove it.")
        }
    }

    /// Its model, and whether this device is in it.
    private func assistantNote(_ assistant: ServerAssistant) -> String {
        let joined = model.session == nil || model.isSignedIn(server: server, assistant: assistant.name)
        return assistant.settings.model.modelId + (joined ? "" : " · Not joined from home")
    }

    private func keySource(_ key: ProviderKey) -> String {
        switch key.source {
        case .env: "From the server's environment (\(key.variables.joined(separator: ", ")))"
        case .server: "Set here, for every assistant. Tap to change it."
        case .assistant: "Set for one assistant"
        case .none: "None yet. Tap to add your key."
        }
    }

    private func reload() async throws {
        let client = try model.servers.client(server)
        info = try await client.info()
        keys = try await client.keys(assistant: nil)
    }

    /// Runs a change, then reads the server again.
    private func act(_ action: () async throws -> Void) async {
        do {
            try await action()
            try await reload()
            problem = nil
        } catch {
            problem = explain(error)
        }
    }
}

/// A new assistant: its name, its model, and who it is for.
private struct NewAssistantView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let server: String
    let keys: [ProviderKey]
    let address: String?
    let changed: () async throws -> Void
    @State private var name = ""
    @State private var provider: String
    @State private var modelId: String
    @State private var forMe: Bool
    @State private var person = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var made: MadeAssistant?
    @State private var tailscale: TailscaleState?

    init(server: String, keys: [ProviderKey], address: String?, changed: @escaping () async throws -> Void) {
        self.server = server
        self.keys = keys
        self.address = address
        self.changed = changed
        let first = keys.first { $0.source != .none }?.provider ?? "anthropic"
        _provider = State(initialValue: first)
        _modelId = State(initialValue: defaultModels[first] ?? "")
        _forMe = State(initialValue: address != nil)
    }

    private var ready: [String] { keys.filter { $0.source != .none }.map(\.provider) }

    /// Whether the home can join it now: it has federation, and when it is only in a tailnet,
    /// this server is in it too.
    private var homeCanJoin: Bool {
        model.homeProblem == nil && (model.homeReach != .tailnet || tailscale?.state == .connected)
    }

    var body: some View {
        Form {
            if let made {
                if let pairing = made.pairing {
                    Section {
                        if let link = URL(string: pairing.link) {
                            ShareLink(item: link, message: Text("Your assistant on Nudge")) {
                                Label("Send the link", systemImage: "square.and.arrow.up")
                            }
                        }
                    } header: {
                        Text("\(made.assistant.settings.displayName) is ready for \(person.trimmed)")
                    } footer: {
                        Text("Send them this link, or have them type the code \(pairing.code) in the Nudge app. It works once, for ten minutes.")
                    }
                } else {
                    Section {
                        Text("You joined it from home: its rooms are beside your own.")
                    } header: {
                        Text("\(made.assistant.settings.displayName) is ready")
                    }
                }
            } else {
                Section {
                    TextField("Its name", text: $name)
                } footer: {
                    Text("In its address: \(slugOf(name).isEmpty ? "…" : slugOf(name))")
                }
                Section("Model") {
                    Picker("Provider", selection: $provider) {
                        ForEach(["anthropic", "openai"], id: \.self) { option in
                            Text(providerName(option) + (ready.contains(option) ? "" : " (add a key on the server first)"))
                                .tag(option)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .onChange(of: provider) { _, option in modelId = defaultModels[option] ?? "" }
                    TextField("Model id", text: $modelId)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                Section("Who is it for?") {
                    Picker("Who is it for?", selection: $forMe) {
                        if model.session != nil {
                            Text("Me: I join it from my home, and keep one sign-in").tag(true)
                        }
                        Text("Someone else: it is their home, and they are its admin").tag(false)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    if !forMe {
                        TextField("Their name", text: $person)
                    }
                }
                if forMe {
                    HomeFederationSection()
                    if model.homeProblem == nil, model.homeReach == .tailnet {
                        if tailscale?.state != .connected {
                            Section {
                                Text("Your home is only in your tailnet, so this server joins it first.")
                            }
                        }
                        TailscaleSection(server: server) { tailscale = $0 }
                    }
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
        }
        .formStyle(.grouped)
        .disabled(busy)
        .navigationTitle("New assistant")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if made != nil {
                    Button("Done") { dismiss() }
                } else if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Make it") { Task { await create() } }
                        .disabled(slugOf(name).isEmpty || modelId.trimmed.isEmpty || (forMe ? !homeCanJoin : person.trimmed.isEmpty))
                }
            }
        }
    }

    private func create() async {
        busy = true
        defer { busy = false }
        do {
            let madeFor: AssistantFor = if forMe, let address = model.memberships?.address ?? address {
                .me(address: address)
            } else {
                .someonesHome(displayName: person.trimmed)
            }
            made = try await model.createAssistant(
                on: server,
                NewAssistant(
                    name: slugOf(name),
                    settings: AssistantSettings(
                        displayName: name.trimmed, model: ModelChoice(provider: provider, modelId: modelId.trimmed),
                        timeZone: nil, instructions: nil, budget: nil),
                    madeFor: madeFor))
            problem = nil
            try? await changed()
        } catch {
            problem = explain(error)
        }
    }
}

/// An assistant's settings, and deleting it.
private struct AssistantView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let server: String
    let assistant: ServerAssistant
    let changed: () async throws -> Void
    @State private var displayName: String
    @State private var modelId: String
    @State private var instructions: String
    @State private var deleting = false
    @State private var confirm = ""
    @State private var problem: String?
    @State private var joining = false

    init(server: String, assistant: ServerAssistant, changed: @escaping () async throws -> Void) {
        self.server = server
        self.assistant = assistant
        self.changed = changed
        _displayName = State(initialValue: assistant.settings.displayName)
        _modelId = State(initialValue: assistant.settings.model.modelId)
        _instructions = State(initialValue: assistant.settings.instructions ?? "")
    }

    var body: some View {
        Form {
            Section("Name") {
                TextField("Name", text: $displayName)
            }
            Section("Model (\(assistant.settings.model.provider))") {
                TextField("Model", text: $modelId)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
            }
            Section {
                TextField("Instructions", text: $instructions, axis: .vertical)
                    .lineLimit(3...12)
            } header: {
                Text("Instructions")
            } footer: {
                Text("Said to the model before every conversation")
            }
            if let problem {
                Section { Text(problem).foregroundStyle(.red) }
            }
            if model.session != nil, !model.isSignedIn(server: server, assistant: assistant.name) {
                HomeFederationSection()
                Section {
                    Button(joining ? "Joining…" : "Join it from home", systemImage: "person.badge.plus") {
                        Task { await join() }
                    }
                    .disabled(joining || model.homeProblem != nil)
                } footer: {
                    Text("Its rooms show beside your home's, and you are its admin and an owner of this server.")
                }
            }
            Section {
                Button("Delete this assistant", role: .destructive) { deleting = true }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(assistant.settings.displayName)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(displayName.trimmed.isEmpty || modelId.trimmed.isEmpty)
            }
        }
        .alert("Delete \(assistant.settings.displayName)?", isPresented: $deleting) {
            TextField(assistant.name, text: $confirm)
                .autocorrectionDisabled()
            Button("Delete", role: .destructive) {
                Task { await act { _ = try await model.servers.client(server).deleteAssistant(name: assistant.name) } }
            }
            .disabled(confirm.trimmed != assistant.name)
            Button("Cancel", role: .cancel) { confirm = "" }
        } message: {
            Text("Its rooms, history and memory go. The server keeps a backup for 30 days. Type \(assistant.name) to delete it.")
        }
    }

    private func join() async {
        joining = true
        defer { joining = false }
        do {
            try await model.joinFromHome(server: server, assistant: assistant.name)
            problem = nil
            try? await changed()
        } catch {
            problem = explain(error)
        }
    }

    private func save() async {
        var settings = assistant.settings
        settings.displayName = displayName.trimmed
        settings.model.modelId = modelId.trimmed
        settings.instructions = instructions.trimmed.isEmpty ? nil : instructions.trimmed
        await act { _ = try await model.servers.client(server).updateAssistant(name: assistant.name, settings: settings) }
    }

    /// Runs a change, then goes back to the server, read again.
    private func act(_ action: () async throws -> Void) async {
        do {
            try await action()
            try? await changed()
            dismiss()
        } catch {
            problem = explain(error)
        }
    }
}
