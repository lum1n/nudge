import Nudge
import SwiftUI

/// The model an assistant answers with, picked from the server's catalog: a provider, then one of
/// its models, with where that provider's key comes from. A provider with no key anywhere gets a
/// field for the server's key, tried once before it is kept. Without a catalog (an older server),
/// the model id is typed instead.
struct ModelPicker: View {
    let catalog: [ServerModelProvider]?
    @Binding var chosen: ModelChoice
    let setKey: (_ provider: String, _ key: String) async throws -> Void
    @State private var entered = ""
    @State private var busy = false
    @State private var problem: String?

    init(
        catalog: [ServerModelProvider]?,
        chosen: Binding<ModelChoice>,
        setKey: @escaping (_ provider: String, _ key: String) async throws -> Void
    ) {
        self.catalog = catalog
        _chosen = chosen
        self.setKey = setKey
    }

    private var provider: ServerModelProvider? { catalog?.first { $0.id == chosen.provider } }

    var body: some View {
        if let catalog {
            Picker("Provider", selection: Binding(
                get: { chosen.provider },
                set: { id in
                    entered = ""
                    problem = nil
                    chosen = ModelChoice(provider: id, modelId: catalog.first { $0.id == id }?.models.first?.id ?? "")
                }
            )) {
                if provider == nil {
                    Text(chosen.provider).tag(chosen.provider)
                }
                ForEach(catalog, id: \.id) { option in
                    Text(option.name).tag(option.id)
                }
            }
            Picker("Model", selection: $chosen.modelId) {
                if provider?.models.contains(where: { $0.id == chosen.modelId }) != true {
                    Text(chosen.modelId.isEmpty ? "—" : chosen.modelId).tag(chosen.modelId)
                }
                ForEach(provider?.models ?? [], id: \.id) { model in
                    Text(model.name).tag(model.id)
                }
            }
            .disabled(provider == nil)
            if let provider {
                Text(keyNote(provider))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if provider.key.source == .none {
                    SecureField("\(provider.name) key", text: $entered)
                    Button(busy ? "Trying the key…" : "Save key") {
                        Task { await saveKey(provider.id) }
                    }
                    .disabled(busy || entered.trimmed.isEmpty)
                    Text(problem ?? "For every assistant here. Tried once before it is kept.")
                        .font(.caption)
                        .foregroundStyle(problem == nil ? Color.secondary : Color.red)
                }
            }
        } else {
            TextField("Model (\(chosen.provider))", text: $chosen.modelId)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
        }
    }

    private func keyNote(_ provider: ServerModelProvider) -> String {
        switch provider.key.source {
        case .env: "Key: the server's environment (\(provider.key.variables.joined(separator: ", ")))."
        case .server: "Key: set on the server."
        case .assistant: "Key: set for this assistant."
        case .none: "No \(provider.name) key yet. Add one to use it."
        }
    }

    private func saveKey(_ id: String) async {
        busy = true
        defer { busy = false }
        do {
            try await setKey(id, entered.trimmed)
            entered = ""
            problem = nil
        } catch {
            problem = explain(error)
        }
    }
}
