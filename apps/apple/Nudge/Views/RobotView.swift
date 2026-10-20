import CoreGraphics
import Nudge
import SwiftUI

/// How the assistant's robot looks to everyone who uses it, in every app, set by an admin. Room
/// lists show a change at once.
struct RobotView: View {
    let session: Session
    @State private var draft: RobotLook?
    @State private var saving = false
    @State private var problem: String?

    private var look: RobotLook { draft ?? session.look }
    private var dirty: Bool { draft != nil && draft != session.look }

    var body: some View {
        Form {
            Section {
                AvatarView(mood: .idle, appearance: look, size: 160)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            }
            Section("Start from") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(RobotLook.presets, id: \.key) { preset in
                            Button { draft = preset.value } label: {
                                VStack(spacing: 4) {
                                    Portrait(appearance: preset.value, size: 48)
                                    Text(preset.key).font(.caption)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            Section("Colours") {
                ColorPicker("Ribbon", selection: colour(\.body.0), supportsOpacity: false)
                ColorPicker("Ribbon end", selection: colour(\.body.1), supportsOpacity: false)
                ColorPicker("Eyes", selection: colour(\.eyes), supportsOpacity: false)
                ColorPicker("Sparks", selection: colour(\.sparks), supportsOpacity: false)
            }
            Section {
                Picker("Eyes", selection: binding(\.eyeShape)) {
                    ForEach(EyeShape.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
                Picker("Wears", selection: binding(\.accessory)) {
                    ForEach(Accessory.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
            }
            if session.roomList.value?.view?.appearance != nil && !dirty {
                Section {
                    Button("Back to the app icon's") { Task { await save(nil) } }.disabled(saving)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Robot")
        .toolbar {
            if dirty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { draft = nil }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save(look) } }.disabled(saving)
                }
            }
        }
        .alert("Couldn't save the robot", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
        } message: {
            Text(problem ?? "")
        }
    }

    private func binding<T>(_ path: WritableKeyPath<RobotLook, T>) -> Binding<T> {
        Binding(get: { look[keyPath: path] }, set: { value in
            var next = look
            next[keyPath: path] = value
            draft = next
        })
    }

    private func colour(_ path: WritableKeyPath<RobotLook, String>) -> Binding<Color> {
        Binding(get: { Color(hex: look[keyPath: path]) }, set: { value in
            guard let hex = value.hex else { return }
            var next = look
            next[keyPath: path] = hex
            draft = next
        })
    }

    private func save(_ next: RobotLook?) async {
        saving = true
        defer { saving = false }
        do {
            _ = try await session.client.setAppearance(appearance: next?.appearance)
            draft = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

extension Color {
    /// As `#rrggbb` in sRGB, for the server.
    var hex: String? {
        let resolved = resolve(in: EnvironmentValues())
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
            let components = resolved.cgColor.converted(to: srgb, intent: .defaultIntent, options: nil)?.components,
            components.count >= 3
        else { return nil }
        let byte = { (x: CGFloat) in Int((min(1, max(0, x)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(components[0]), byte(components[1]), byte(components[2]))
    }
}
