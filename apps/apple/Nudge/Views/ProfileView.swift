import ImageIO
import Nudge
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The player's profile at home: name, picture, time zone, language, which pushes they get, and
/// each extension's settings for them. Their home sends it to every assistant they joined. Their
/// personal details and where they are stay at home.
struct ProfileView: View {
    @Environment(AppModel.self) private var model
    let client: NudgeClient
    @State private var draft: Draft?
    @State private var personal: Personal?
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

    /// The personal details in the form until they are saved.
    struct Personal: Equatable {
        var fullName: String
        var email: String
        var phone: String
        var address: String

        init(_ details: PersonalDetails) {
            fullName = details.fullName ?? ""
            email = details.email ?? ""
            phone = details.phone ?? ""
            address = details.address ?? ""
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
        .onChange(of: personal) { old, _ in if old != nil { saved = false } }
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
        if let personal = Binding($personal) {
            personalSection(personal)
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

    @ViewBuilder
    private func personalSection(_ personal: Binding<Personal>) -> some View {
        Section {
            TextField("Full name", text: personal.fullName)
                .textContentType(.name)
            TextField("E-mail", text: personal.email)
                .textContentType(.emailAddress)
            #if os(iOS)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
            #endif
            TextField("Phone", text: personal.phone)
                .textContentType(.telephoneNumber)
            #if os(iOS)
                .keyboardType(.phonePad)
            #endif
            TextField("Address", text: personal.address, axis: .vertical)
                .textContentType(.fullStreetAddress)
            Toggle(isOn: Binding(
                get: { model.location.enabled },
                set: { on in Task { await model.location.setEnabled(on) } }
            )) {
                VStack(alignment: .leading) {
                    Text("Share where I am")
                    if model.location.enabled, let known = model.location.known {
                        Text("\(known.text), \(Date(timeIntervalSince1970: known.at / 1000).formatted(date: .omitted, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if let problem = model.location.problem {
                Text(problem).font(.caption).foregroundStyle(.red)
            }
        } header: {
            Text("Personal details")
        } footer: {
            Text("For filling in forms, writing mail and finding what is near you. Only you see them, and they stay at home: the model gets placeholders such as ⟦EMAIL1⟧, in your own room and private messages, and tools get the real values. Your location is sent while the app is open.")
        }
    }

    private func load() async {
        do {
            draft = Draft(try await client.profile())
            personal = (try? await client.personal()).map(Personal.init)
            await model.location.refresh()
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
            if let personal {
                // An empty string clears one.
                let trimmed = { (value: String) in value.trimmingCharacters(in: .whitespacesAndNewlines) }
                self.personal = Personal(try await client.updatePersonal(update: PersonalUpdate(
                    fullName: trimmed(personal.fullName),
                    email: trimmed(personal.email),
                    phone: trimmed(personal.phone),
                    address: trimmed(personal.address))))
            }
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
