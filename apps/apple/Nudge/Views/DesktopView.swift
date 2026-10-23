import ImageIO
import Nudge
import SwiftUI

/// How far a finger moves on the desktop's screen, in its pixels, for one notch of scrolling.
private let notchPixels = 60.0

/// The room's desktop, live: watch the assistant use its apps, or take over. Taps, drags and
/// typing go to that desktop only.
struct DesktopView: View {
    let client: NudgeClient
    let roomId: String
    @State private var desktop: ObservedDesktop?
    @State private var openingError: String?
    /// The screen as drawn so far, each patch over the last.
    @State private var screen: CGImage?

    var body: some View {
        content
            .navigationTitle("Desktop")
            .onAppear {
                guard desktop == nil else { return }
                do {
                    desktop = try client.observeDesktop(roomId)
                } catch {
                    openingError = explain(error)
                }
            }
            .onDisappear {
                desktop?.close()
                desktop = nil
                screen = nil
            }
            .task(id: desktop.map { ObjectIdentifier($0) }) {
                guard let desktop else { return }
                let composer = ScreenComposer()
                for await patch in desktop.patches {
                    if let drawn = await composer.draw(patch) { screen = drawn }
                }
            }
    }

    @ViewBuilder private var content: some View {
        let state = desktop?.value
        if let openingError {
            ContentUnavailableView("Can't open the desktop", systemImage: "exclamationmark.triangle", description: Text(openingError))
        } else if case .closed(let code, let reason)? = state?.status {
            ContentUnavailableView(
                code == 4404 ? "This room has no desktop" : "Disconnected", systemImage: "desktopcomputer",
                description: Text(code == 4404 ? "Turn on the desktop extension for this room under Room." : reason))
        } else if let desktop, let state, case .open = state.status {
            LiveDesktop(desktop: desktop, state: state, screen: screen)
        } else {
            ProgressView("Starting the desktop…")
        }
    }
}

/// Draws each patch over the screen so far, off the main actor, and hands back the whole screen.
private actor ScreenComposer {
    private var context: CGContext?

    func draw(_ patch: DesktopPatch) -> CGImage? {
        guard patch.screenWidth > 0, patch.screenHeight > 0,
            let source = CGImageSourceCreateWithData(patch.png as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        if context?.width != patch.screenWidth || context?.height != patch.screenHeight {
            context = CGContext(
                data: nil, width: patch.screenWidth, height: patch.screenHeight, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        }
        guard let context else { return nil }
        // The patch's y counts from the top; the context's from the bottom.
        context.draw(
            image,
            in: CGRect(x: patch.x, y: patch.screenHeight - patch.y - patch.height, width: patch.width, height: patch.height))
        return context.makeImage()
    }
}

private struct LiveDesktop: View {
    let desktop: ObservedDesktop
    let state: DesktopState
    let screen: CGImage?
    @State private var typed = ""
    /// What of `typed` went to the desktop already.
    @State private var sent = ""
    /// With a mouse, a drag selects; with a finger, it scrolls unless this is on.
    #if os(macOS)
    @State private var selecting = true
    #else
    @State private var selecting = false
    #endif

    private var inControl: Bool { state.control?.you == true }

    var body: some View {
        Form {
            Section {
                Text("This is the room's own desktop. Watch the assistant use its apps, or take over: tap to click, and type below into the window you tapped.")
                    .font(.callout).foregroundStyle(.secondary)
                if let control = state.control, !control.you {
                    HStack {
                        Text("\(control.holder ?? "Someone else") is using the desktop; you are watching.")
                        Spacer()
                        Button("Take control") { desktop.takeControl() }
                            .buttonStyle(.glassProminent)
                    }
                }
                if !state.apps.isEmpty || !state.windows.isEmpty {
                    // No window manager: windows come to the front from here, and apps start from here.
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(state.apps, id: \.self) { app in
                                Button("Start \(app)", systemImage: "plus.app") { desktop.launch(app) }
                            }
                            ForEach(state.windows) { window in
                                Button(window.title.isEmpty ? window.app : window.title, systemImage: "macwindow") {
                                    desktop.raise(window)
                                    clearTyping()
                                }
                                .lineLimit(1)
                            }
                        }
                        .buttonStyle(.glass)
                        .controlSize(.small)
                    }
                    .disabled(!inControl)
                }
            }
            Section {
                // A tap may focus another field, where typing starts over.
                Screen(image: screen, state: state, inControl: inControl, selecting: selecting, desktop: desktop, tapped: clearTyping)
                    .listRowInsets(EdgeInsets())
                Toggle("Drag to select", isOn: $selecting)
                if let working = state.working {
                    Text("The assistant: \(working)")
                }
            } footer: {
                Text(selecting ? "Dragging selects and moves things." : "Dragging scrolls.")
            }
            Section {
                TextField("Type into the desktop", text: $typed)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit {
                        desktop.press("Enter")
                        clearTyping()
                    }
                    .onChange(of: typed) { relay(typed) }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(["Tab", "Enter", "Backspace", "Escape", "ctrl+s", "ctrl+z"], id: \.self) { key in
                            Button(label(key)) {
                                desktop.press(key)
                                if key != "Backspace" { clearTyping() }
                            }
                        }
                    }
                    .buttonStyle(.glass)
                    .controlSize(.small)
                }
                if let error = state.error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .disabled(!inControl)
        }
        .formStyle(.grouped)
    }

    private func label(_ key: String) -> String {
        switch key {
        case "Escape": "Esc"
        case "ctrl+s": "Ctrl+S"
        case "ctrl+z": "Ctrl+Z"
        default: key
        }
    }

    private func clearTyping() {
        typed = ""
        sent = ""
    }

    /// Added letters go to the desktop as text, removed ones as Backspace.
    private func relay(_ next: String) {
        let common = zip(sent, next).prefix { $0 == $1 }.count
        for _ in 0..<(sent.count - common) { desktop.press("Backspace") }
        if next.count > common { desktop.type(String(next.dropFirst(common))) }
        sent = next
    }
}

/// The desktop's screen, as wide as there is room: a tap clicks there, a double tap
/// double-clicks, a long press right-clicks, a drag scrolls or, while selecting, drags, and keys
/// pressed while it has focus go to it.
private struct Screen: View {
    let image: CGImage?
    let state: DesktopState
    let inControl: Bool
    let selecting: Bool
    let desktop: ObservedDesktop
    let tapped: () -> Void
    /// Of the drag going on: how far it had moved at the last change, and the scroll not sent yet.
    @State private var dragged: CGSize = .zero
    @State private var scrolled = 0.0
    @State private var movedAt = Date.distantPast

    var body: some View {
        if let image, state.screenWidth > 0, state.screenHeight > 0 {
            GeometryReader { geometry in
                let size = geometry.size
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: size.width, height: size.height)
                    .opacity(inControl ? 1 : 0.85)
                    .contentShape(Rectangle())
                    .gesture(
                        SpatialTapGesture(count: 2)
                            .onEnded { value in
                                guard inControl else { return }
                                let (x, y) = screen(value.location, in: size)
                                desktop.click(x: x, y: y, double: true)
                            }
                            .exclusively(
                                before: SpatialTapGesture().onEnded { value in
                                    guard inControl else { return }
                                    let (x, y) = screen(value.location, in: size)
                                    desktop.click(x: x, y: y)
                                    tapped()
                                })
                    )
                    .simultaneousGesture(
                        // Held, then let go: a right click where it was let go.
                        LongPressGesture(minimumDuration: 0.5)
                            .sequenced(before: DragGesture(minimumDistance: 0))
                            .onEnded { value in
                                guard inControl, case .second(true, let drag?) = value else { return }
                                let (x, y) = screen(drag.location, in: size)
                                desktop.click(x: x, y: y, button: "right")
                            }
                    )
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { value in
                                guard inControl, !selecting else { return }
                                // Whole notches, as a mouse wheel turns: the content follows the finger.
                                let scale = Double(state.screenHeight) / size.height
                                scrolled -= (value.translation.height - dragged.height) * scale
                                dragged = value.translation
                                guard abs(scrolled) >= notchPixels else { return }
                                let (x, y) = screen(value.location, in: size)
                                desktop.scroll(x: x, y: y, dx: 0, dy: scrolled > 0 ? 100 : -100)
                                scrolled -= scrolled > 0 ? notchPixels : -notchPixels
                            }
                            .onEnded { value in
                                dragged = .zero
                                scrolled = 0
                                guard inControl, selecting else { return }
                                let (fromX, fromY) = screen(value.startLocation, in: size)
                                let (toX, toY) = screen(value.location, in: size)
                                desktop.drag(fromX: fromX, fromY: fromY, toX: toX, toY: toY)
                            }
                    )
                    // Menus open on hover; a move at most every 100 ms is enough for that.
                    .onContinuousHover { phase in
                        guard inControl, case .active(let location) = phase, Date().timeIntervalSince(movedAt) > 0.1 else { return }
                        movedAt = Date()
                        let (x, y) = screen(location, in: size)
                        desktop.move(x: x, y: y)
                    }
                    .focusable(inControl)
                    .onKeyPress(phases: .down) { press in key(press) }
            }
            .aspectRatio(CGFloat(state.screenWidth) / CGFloat(state.screenHeight), contentMode: .fit)
            .accessibilityLabel("The room's desktop")
        } else {
            Text("Waiting for the screen…")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 240)
        }
    }

    private func screen(_ point: CGPoint, in size: CGSize) -> (Int, Int) {
        guard size.width > 0, size.height > 0 else { return (0, 0) }
        return (Int(point.x / size.width * Double(state.screenWidth)), Int(point.y / size.height * Double(state.screenHeight)))
    }

    /// A hardware key: printable characters as text, the rest as combos (Command is Control, as
    /// the desktop's Linux apps expect).
    private func key(_ press: KeyPress) -> KeyPress.Result {
        guard inControl else { return .ignored }
        let named: [(KeyEquivalent, String)] = [
            (.return, "Enter"), (.delete, "Backspace"), (.tab, "Tab"), (.escape, "Escape"), (.deleteForward, "Delete"),
            (.home, "Home"), (.end, "End"), (.pageUp, "PageUp"), (.pageDown, "PageDown"), (.upArrow, "ArrowUp"),
            (.downArrow, "ArrowDown"), (.leftArrow, "ArrowLeft"), (.rightArrow, "ArrowRight"), (.space, "space"),
        ]
        let name = named.first(where: { $0.0 == press.key })?.1
        let control = press.modifiers.contains(.command) || press.modifiers.contains(.control)
        let alt = press.modifiers.contains(.option)
        var modifiers: [String] = []
        if control { modifiers.append("ctrl") }
        if alt { modifiers.append("alt") }
        if press.modifiers.contains(.shift) && (name != nil || control || alt) { modifiers.append("shift") }
        if let name, name != "space" || !modifiers.isEmpty {
            desktop.press((modifiers + [name]).joined(separator: "+"))
            return .handled
        }
        guard !press.characters.isEmpty else { return .ignored }
        if modifiers.isEmpty {
            desktop.type(press.characters)
        } else {
            // With Option, characters are what it made; the key is the plain one.
            let plain = press.key.character.lowercased()
            desktop.press((modifiers + [plain]).joined(separator: "+"))
        }
        return .handled
    }
}
