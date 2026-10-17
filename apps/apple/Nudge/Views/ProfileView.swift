import ImageIO
import Nudge
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The player's profile at home: name, picture, time zone, language, which pushes they get, and
/// each extension's settings for them. Their home sends it to every assistant they joined.
struct ProfileView: View {
    let client: NudgeClient
    @State private var draft: Draft?
    @State private var extensions: [PlayerSettings] = []
    @State private var picked: PhotosPickerItem?
    @State private var busy = false
    @State private var saved = false
    @State private var problem: String?

    /// What the form holds until it is saved.
    struct Draft: Equatable {
        var displayName: String
        var avatar: String?
        var timeZone: String
        var language: String
        var notifications: Notifications
        var extensions: [String: [String: JSONValue]]

        init(_ profile: Profile) {
            displayName = profile.displayName
            avatar = profile.avatar
            timeZone = profile.timeZone ?? ""
            language = profile.language ?? ""
            notifications = profile.notifications
            extensions = (JSONValue(json: profile.extensionsJson)?.object ?? [:]).compactMapValues(\.object)
        }
    }

    var body: some View {
        Form {
            if let binding = Binding($draft) {
                form(binding)
            } else if let problem {
                Text(problem).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Profile")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(saved ? "Saved" : "Save") { Task { await save() } }
                    .disabled(busy || draft == nil || draft?.displayName.trimmingCharacters(in: .whitespaces).isEmpty == true)
            }
        }
        .onChange(of: draft) { old, _ in if old != nil { saved = false } }
        .onChange(of: picked) { _, item in Task { await pick(item) } }
        .task { await load() }
    }

    @ViewBuilder
    private func form(_ draft: Binding<Draft>) -> some View {
        Section {
            HStack(spacing: 14) {
                Avatar(dataURL: draft.wrappedValue.avatar)
                PhotosPicker("Choose a picture", selection: $picked, matching: .images)
                if draft.wrappedValue.avatar != nil {
                    Button("Remove", role: .destructive) { draft.wrappedValue.avatar = nil }
                }
            }
            TextField("Name", text: draft.displayName)
        } footer: {
            Text("Assistants you joined get this too.")
        }
        Section {
            TextField("Time zone", text: draft.timeZone, prompt: Text("The assistant's"))
            if draft.wrappedValue.timeZone != TimeZone.current.identifier {
                Button("Use this device's: \(TimeZone.current.identifier)") {
                    draft.wrappedValue.timeZone = TimeZone.current.identifier
                }
            }
            TextField("Language", text: draft.language, prompt: Text("Such as en, nb or de"))
            if let mine = Locale.current.language.languageCode?.identifier, draft.wrappedValue.language != mine {
                Button("Use this device's: \(mine)") { draft.wrappedValue.language = mine }
            }
        } footer: {
            Text("The assistant reads your nudges' times in your time zone and answers you in your language.")
        }
        Section("Notifications") {
            Toggle("Answers and nudges", isOn: draft.notifications.answers)
            Toggle("Actions waiting for approval", isOn: draft.notifications.approvals)
        }
        ForEach(extensions, id: \.name) { extensionSettings in
            Section {
                SettingFieldsView(
                    fields: SettingField.fields(schemaJson: extensionSettings.schemaJson),
                    value: Binding(
                        get: { draft.wrappedValue.extensions[extensionSettings.name] ?? [:] },
                        set: { draft.wrappedValue.extensions[extensionSettings.name] = $0 }))
            } header: {
                Text(extensionSettings.name)
            } footer: {
                if let description = extensionSettings.description { Text(description) }
            }
        }
        if let problem {
            Section { Text(problem).foregroundStyle(.red) }
        }
    }

    private func load() async {
        do {
            draft = Draft(try await client.profile())
            extensions = (try? await client.profileExtensions()) ?? []
        } catch {
            problem = explain(error)
        }
    }

    private func pick(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        if let data = try? await item.loadTransferable(type: Data.self), let avatar = avatarURL(from: data) {
            draft?.avatar = avatar
        } else {
            problem = "That picture could not be read."
        }
        picked = nil
    }

    private func save() async {
        guard let draft else { return }
        busy = true
        defer { busy = false }
        // Each extension's settings without the values that equal their defaults, or null when
        // nothing is left.
        var chosen: [String: JSONValue] = [:]
        for extensionSettings in extensions {
            let defaults = Dictionary(
                SettingField.fields(schemaJson: extensionSettings.schemaJson).map { ($0.name, $0.defaultValue) }
            ) { first, _ in first }
            let kept = (draft.extensions[extensionSettings.name] ?? [:])
                .filter { key, value in (defaults[key] ?? nil).map { $0 != value } ?? true }
            chosen[extensionSettings.name] = kept.isEmpty ? .null : .object(kept)
        }
        do {
            let next = try await client.updateProfile(update: ProfileUpdate(
                displayName: draft.displayName.trimmingCharacters(in: .whitespaces),
                // An empty string clears it.
                avatar: draft.avatar ?? "",
                timeZone: draft.timeZone.trimmingCharacters(in: .whitespaces),
                language: draft.language.trimmingCharacters(in: .whitespaces),
                notifications: draft.notifications,
                extensionsJson: chosen.isEmpty ? nil : JSONValue.object(chosen).json))
            self.draft = Draft(next)
            problem = nil
            saved = true
        } catch {
            problem = explain(error)
        }
    }
}

private struct Avatar: View {
    let dataURL: String?

    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: 1).resizable().scaledToFill()
            } else {
                Color.secondary.opacity(0.2)
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(.circle)
    }

    private var image: CGImage? {
        guard let base64 = dataURL?.split(separator: ",", maxSplits: 1).last,
            let data = Data(base64Encoded: String(base64)),
            let source = CGImageSourceCreateWithData(data as CFData, nil)
        else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}

/// Avatars are kept small: a 128 px square JPEG, as a data URL.
private func avatarURL(from data: Data) -> String? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return nil }
    let side = min(image.width, image.height)
    guard let square = image.cropping(to: CGRect(
            x: (image.width - side) / 2, y: (image.height - side) / 2, width: side, height: side)),
        let context = CGContext(
            data: nil, width: 128, height: 128, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    context.interpolationQuality = .high
    context.draw(square, in: CGRect(x: 0, y: 0, width: 128, height: 128))
    guard let small = context.makeImage() else { return nil }
    let out = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, small, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return "data:image/jpeg;base64," + (out as Data).base64EncodedString()
}
