import Nudge
import SwiftUI

/// The assistant's extensions, set up by an admin: on or off, their settings and the rooms they
/// are on in. Saving installs them again on the server and writes its nudge.json; if one fails to
/// start, nothing changes.
struct ExtensionsView: View {
    let client: NudgeClient
    @State private var setups: [ExtensionSetup]?
    @State private var drafts: [String: Draft] = [:]
    @State private var loadProblem: String?
    @State private var problem: String?
    @State private var saving = false
    @State private var saved = false

    /// One extension as the screen edits it, before it is saved.
    struct Draft: Equatable {
        var enabled: Bool
        var settings: [String: JSONValue]
        var rooms: [RoomKind]?

        init(_ setup: ExtensionSetup) {
            enabled = setup.enabled
            settings = setup.settings
            rooms = setup.rooms
        }
    }

    var body: some View {
        content
            .navigationTitle("Extensions")
            .toolbar {
                if dirty {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Discard") { show(setups ?? []) }.disabled(saving)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(saving)
                    }
                }
            }
            .task { await load() }
    }

    @ViewBuilder private var content: some View {
        if let loadProblem {
            ContentUnavailableView("Can't set up extensions", systemImage: "puzzlepiece.extension", description: Text(loadProblem))
        } else if let setups {
            Form {
                Section {
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    } else if saved && !dirty {
                        Text("Saved and installed.").foregroundStyle(.green)
                    }
                } footer: {
                    Text("What the assistant can do beyond talking. Saving installs them again right away and writes them to the server's nudge.json; if one fails to start, nothing changes. Each room can still turn them on or off for itself.")
                }
                let added = setups.filter(\.configured)
                let available = setups.filter { !$0.configured }
                ForEach(added, id: \.from) { setup in
                    ExtensionSection(setup: setup, draft: binding(setup), title: setup.from == added.first?.from ? "Added" : nil)
                }
                ForEach(available, id: \.from) { setup in
                    ExtensionSection(
                        setup: setup, draft: binding(setup),
                        title: setup.from == available.first?.from ? "Not added yet" : nil)
                }
            }
            .formStyle(.grouped)
        } else {
            ProgressView()
        }
    }

    private var dirty: Bool {
        (setups ?? []).contains { drafts[$0.from] != Draft($0) }
    }

    private func binding(_ setup: ExtensionSetup) -> Binding<Draft> {
        Binding(
            get: { drafts[setup.from] ?? Draft(setup) },
            set: {
                saved = false
                drafts[setup.from] = $0
            })
    }

    private func show(_ next: [ExtensionSetup]) {
        setups = next
        drafts = Dictionary(next.map { ($0.from, Draft($0)) }) { first, _ in first }
        problem = nil
    }

    private func load() async {
        do {
            show(try await client.extensionSetups())
        } catch NudgeError.Status(404, _) {
            loadProblem = "This server can't set up extensions from the app. Run it with nudge serve."
        } catch {
            loadProblem = explain(error)
        }
    }

    private func save() async {
        guard let setups else { return }
        saving = true
        defer { saving = false }
        do {
            let next = try await client.saveExtensionSetups(
                extensions: setups
                    // One found beside the config is only added once it is turned on.
                    .filter { drafts[$0.from]?.enabled == true || $0.configured }
                    .map { setup in
                        let draft = drafts[setup.from] ?? Draft(setup)
                        return setup.saved(enabled: draft.enabled, settings: draft.settings, rooms: draft.rooms)
                    })
            show(next)
            saved = true
        } catch {
            problem = explain(error)
        }
    }
}

private let kinds: [(RoomKind, String)] = [(.lobby, "Everyone"), (.personal, "Personal"), (.shared, "Shared")]

private struct ExtensionSection: View {
    let setup: ExtensionSetup
    @Binding var draft: ExtensionsView.Draft
    /// Above the first of a group.
    let title: String?
    @State private var open = false

    var body: some View {
        Section {
            Toggle(isOn: $draft.enabled) {
                HStack(alignment: .firstTextBaseline) {
                    Text(setup.name ?? setup.from)
                    if let version = setup.version {
                        Text(version).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let description = setup.description { Text(description) }
            }
            .disabled(setup.error != nil)
            if let error = setup.error {
                Text("Couldn't load it: \(error)").foregroundStyle(.red)
            }
            if !setup.missingEnv.isEmpty {
                Text("Needs \(setup.missingEnv.map { "$\($0)" }.formatted(.list(type: .and))) in the server's environment, or the value in its settings, before it can start.")
                    .font(.callout).foregroundStyle(.orange)
            }
            if setup.error == nil || !setup.settingFields.isEmpty {
                DisclosureGroup(setup.settingFields.isEmpty ? "Rooms" : "Settings", isExpanded: $open) {
                    if !setup.settingFields.isEmpty {
                        SettingFieldsView(fields: setup.settingFields, value: $draft.settings)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("On by default in").font(.headline)
                        ForEach(kinds, id: \.0) { kind, label in
                            Toggle(label, isOn: room(kind))
                        }
                        Text("People in a room can still turn it on or off there.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.top, 8)
                }
            }
        } header: {
            if let title { Text(title) }
        }
    }

    private func room(_ kind: RoomKind) -> Binding<Bool> {
        Binding(
            get: { (draft.rooms ?? kinds.map(\.0)).contains(kind) },
            set: { on in
                let rooms = draft.rooms ?? kinds.map(\.0)
                let next = kinds.map(\.0).filter { $0 == kind ? on : rooms.contains($0) }
                draft.rooms = next.count == kinds.count ? nil : next
            })
    }
}

/// Controls for an extension's settings, drawn from its JSON Schema; a field set to nil is left
/// out of the object.
struct SettingFieldsView: View {
    let fields: [SettingField]
    @Binding var value: [String: JSONValue]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(fields) { field in
                SettingControl(field: field, value: Binding(
                    get: { value[field.name] },
                    set: { value[field.name] = $0 }))
            }
        }
    }
}

private struct SettingControl: View {
    let field: SettingField
    @Binding var value: JSONValue?
    @State private var revealed = false

    private var label: String { field.label + (field.required && field.defaultValue == nil ? " *" : "") }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch field.kind {
            case .toggle:
                Toggle(label, isOn: Binding(
                    get: { value?.bool ?? field.defaultValue?.bool ?? false },
                    set: { value = .bool($0) }))
            case .text(let secret):
                Text(label).font(.subheadline)
                let text = Binding(get: { value?.string ?? "" }, set: { value = $0.isEmpty ? nil : .string($0) })
                HStack {
                    if secret && !revealed {
                        SecureField(shown(field.defaultValue), text: text)
                    } else {
                        TextField(shown(field.defaultValue), text: text)
                            .font(.body.monospaced())
                            .autocorrectionDisabled()
                    }
                    if secret {
                        Button(revealed ? "Hide" : "Show", systemImage: revealed ? "eye.slash" : "eye") { revealed.toggle() }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                    }
                }
                .textFieldStyle(.roundedBorder)
            case .number(let integer, _, _):
                Text(label).font(.subheadline)
                TextField(shown(field.defaultValue), value: Binding(
                    get: { value?.number },
                    set: { number in
                        value = number.map { .number(integer ? $0.rounded() : $0) }
                    }), format: .number)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .keyboardType(integer ? .numberPad : .decimalPad)
                    #endif
            case .choice(let options):
                Picker(label, selection: Binding(
                    get: { value.flatMap { options.firstIndex(of: $0) } ?? -1 },
                    set: { value = $0 < 0 ? nil : options[$0] })) {
                    if !field.required || field.defaultValue != nil {
                        Text(field.defaultValue.map { "Default (\(shown($0)))" } ?? "—").tag(-1)
                    }
                    ForEach(options.indices, id: \.self) { index in
                        Text(shown(options[index])).tag(index)
                    }
                }
            case .lines:
                Text(label).font(.subheadline)
                LinesField(value: $value)
            case .group(let fields):
                Text(label).font(.headline)
                SettingGroup(fields: fields, value: $value)
            case .items(let fields):
                Text(label).font(.headline)
                SettingItems(field: field, fields: fields, value: $value)
            case .json:
                Text(label).font(.subheadline)
                JSONField(value: $value)
            }
            if let help { Text(help).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private var help: String? {
        var parts: [String] = []
        if let description = field.description { parts.append(description) }
        if case .number(_, let minimum, let maximum) = field.kind, minimum != nil || maximum != nil {
            let range = [minimum.map { "at least \(shown(.number($0)))" }, maximum.map { "at most \(shown(.number($0)))" }]
                .compactMap(\.self).joined(separator: ", ")
            parts.append("(\(range))")
        }
        switch field.kind {
        case .text, .number: if let value = field.defaultValue { parts.append("Default \(shown(value)).") }
        default: break
        }
        if case .text(true) = field.kind, field.description?.contains("${") != true {
            parts.append("Write ${NAME} to take it from the server's environment; anything else is saved in nudge.json as written.")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}

/// An object of its own fields, drawn inset.
private struct SettingGroup: View {
    let fields: [SettingField]
    @Binding var value: JSONValue?

    var body: some View {
        // Type-erased: the form nests itself.
        AnyView(
            SettingFieldsView(fields: fields, value: Binding(
                get: { value?.object ?? [:] },
                set: { value = $0.isEmpty ? nil : .object($0) }))
                .padding(12)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12)))
    }
}

/// A list of objects, such as mail accounts.
private struct SettingItems: View {
    let field: SettingField
    let fields: [SettingField]
    @Binding var value: JSONValue?

    private var items: [[String: JSONValue]] { value?.array?.map { $0.object ?? [:] } ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("\(field.label.hasSuffix("s") ? String(field.label.dropLast()) : field.label) \(index + 1)")
                            .font(.caption.bold()).foregroundStyle(.secondary)
                        Spacer()
                        Button("Remove", role: .destructive) {
                            set(items.enumerated().filter { $0.offset != index }.map(\.element))
                        }
                        .buttonStyle(.borderless)
                    }
                    AnyView(SettingFieldsView(fields: fields, value: Binding(
                        get: { items.indices.contains(index) ? items[index] : [:] },
                        set: { next in
                            var all = items
                            if all.indices.contains(index) { all[index] = next }
                            set(all)
                        })))
                }
                .padding(12)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12))
            }
            Button("Add", systemImage: "plus") { set(items + [[:]]) }
                .buttonStyle(.glass)
        }
    }

    private func set(_ next: [[String: JSONValue]]) {
        value = next.isEmpty && !field.required ? nil : .array(next.map(JSONValue.object))
    }
}

/// A list of strings, one per line; kept as typed until it changes from elsewhere.
private struct LinesField: View {
    @Binding var value: JSONValue?
    @State private var text = ""

    var body: some View {
        TextField("One per line", text: $text, axis: .vertical)
            .font(.body.monospaced())
            .lineLimit(2...8)
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            .onAppear { text = lines(value).joined(separator: "\n") }
            .onChange(of: text) {
                let next = split(text)
                value = next.isEmpty ? nil : .array(next.map(JSONValue.string))
            }
            .onChange(of: value) {
                if split(text) != lines(value) { text = lines(value).joined(separator: "\n") }
            }
    }

    private func lines(_ value: JSONValue?) -> [String] { value?.array?.compactMap(\.string) ?? [] }

    private func split(_ text: String) -> [String] {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// Anything the fields above don't cover, as JSON; kept as text until it parses.
private struct JSONField: View {
    @Binding var value: JSONValue?
    @State private var text = ""
    @State private var wrong = false

    var body: some View {
        TextField("JSON", text: $text, axis: .vertical)
            .font(.caption.monospaced())
            .lineLimit(3...12)
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            .onAppear { text = value?.json ?? "" }
            .onChange(of: text) {
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    wrong = false
                    value = nil
                } else if let parsed = JSONValue(json: text) {
                    wrong = false
                    value = parsed
                } else {
                    wrong = true
                }
            }
        if wrong { Text("Not valid JSON yet").font(.caption).foregroundStyle(.orange) }
    }
}

/// A value as the form shows it: strings without quotes, whole numbers without a point.
private func shown(_ value: JSONValue?) -> String {
    switch value {
    case .string(let text)?: text
    case .number(let number)? where number.rounded() == number && abs(number) < 1e15: String(Int64(number))
    case .number(let number)?: String(number)
    case .bool(let bool)?: bool ? "true" : "false"
    case nil, .null?: ""
    case let other?: other.json
    }
}
