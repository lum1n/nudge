import ImageIO
import Nudge
import SwiftUI

/// The room's own browser, live: log in to a site here when the assistant asks. Taps, scrolls and
/// typing go to that browser only; the assistant never sees passwords.
struct BrowserView: View {
    let client: NudgeClient
    let roomId: String
    @State private var browser: ObservedBrowser?
    @State private var openingError: String?

    var body: some View {
        content
            .navigationTitle("Browser")
            .onAppear {
                guard browser == nil else { return }
                do {
                    browser = try client.observeBrowser(roomId)
                } catch {
                    openingError = explain(error)
                }
            }
            .onDisappear {
                browser?.close()
                browser = nil
            }
    }

    @ViewBuilder private var content: some View {
        let state = browser?.value
        if let openingError {
            ContentUnavailableView("Can't open the browser", systemImage: "exclamationmark.triangle", description: Text(openingError))
        } else if case .closed(let code, let reason)? = state?.status {
            ContentUnavailableView(
                code == 4404 ? "This room has no browser" : "Disconnected", systemImage: "globe",
                description: Text(code == 4404 ? "Turn on the browser extension for this room under Room." : reason))
        } else if let browser, let state, case .open = state.status {
            LiveBrowser(browser: browser, state: state)
        } else {
            ProgressView("Starting the browser…")
        }
    }
}

private struct LiveBrowser: View {
    let browser: ObservedBrowser
    let state: BrowserState
    @State private var address = ""
    @State private var typed = ""
    /// What of `typed` went to the page already.
    @State private var sent = ""
    @State private var remember = true
    @FocusState private var typing: Bool

    private var inControl: Bool { state.control?.you == true }

    var body: some View {
        Form {
            Section {
                Text("This is the room's own browser. Log in to a site here when the assistant asks you to. What you type goes to this browser only; the assistant never sees passwords.")
                    .font(.callout).foregroundStyle(.secondary)
                if let control = state.control, !control.you {
                    HStack {
                        Text("\(control.holder ?? "Someone else") is using the browser; you are watching.")
                        Spacer()
                        Button("Take control") { browser.takeControl() }
                            .buttonStyle(.glassProminent)
                    }
                }
                HStack {
                    Button("Back", systemImage: "chevron.backward") { browser.back() }
                        .labelStyle(.iconOnly)
                    TextField("Address", text: $address)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit {
                            let url = address.trimmingCharacters(in: .whitespaces)
                            if !url.isEmpty { browser.navigate(to: url) }
                        }
                }
                .disabled(!inControl)
            }
            Section {
                // A tap may focus another field, where typing starts over.
                Page(frame: state.frame, inControl: inControl, browser: browser) {
                    typed = ""
                    sent = ""
                }
                    .listRowInsets(EdgeInsets())
            }
            Section {
                // Hidden like a password, since the page shows what a field may show.
                SecureField("Type into the page", text: $typed)
                    .focused($typing)
                    .autocorrectionDisabled()
                    .onSubmit {
                        browser.press("Enter")
                        typed = ""
                        sent = ""
                    }
                    .onChange(of: typed) { relay(typed) }
                    // A secure field empties itself when typed into again; start over then.
                    .onChange(of: typing) {
                        typed = ""
                        sent = ""
                    }
                HStack {
                    ForEach(["Tab", "Enter", "Backspace", "Escape"], id: \.self) { key in
                        Button(key == "Escape" ? "Esc" : key) {
                            browser.press(key)
                            if key != "Backspace" {
                                typed = ""
                                sent = ""
                            }
                        }
                        .buttonStyle(.glass)
                    }
                }
                .controlSize(.small)
            }
            .disabled(!inControl)
            Section {
                Toggle("Remember logins I type here, so the assistant can log in by itself next time", isOn: $remember)
                Button("Done") { browser.done(remember: remember) }
                    .buttonStyle(.glassProminent)
                    .disabled(!inControl)
                if let saved = state.saved {
                    Text((saved.isEmpty ? "Nothing to save." : "Saved the login for \(saved.formatted(.list(type: .and)))") + " Ask the assistant to try again.")
                }
                if let error = state.error {
                    Text(error).foregroundStyle(.red)
                }
            }
            Section("Saved logins") {
                let logins = state.logins ?? []
                if logins.isEmpty {
                    Text("None yet. Logins you remember here show up here.").foregroundStyle(.secondary)
                }
                ForEach(logins) { login in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(login.host)
                            Text([login.username, "saved \(date(login.savedAt).formatted(date: .abbreviated, time: .omitted))"]
                                .compactMap(\.self).joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Forget") { browser.forget(login) }
                            .buttonStyle(.glass)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { address = state.frame?.url ?? "" }
        .onChange(of: state.frame?.url) { address = state.frame?.url ?? address }
    }

    /// Added letters go to the page as text, removed ones as Backspace.
    private func relay(_ next: String) {
        let common = zip(sent, next).prefix { $0 == $1 }.count
        for _ in 0..<(sent.count - common) { browser.press("Backspace") }
        if next.count > common { browser.type(String(next.dropFirst(common))) }
        sent = next
    }
}

/// The page, as wide as there is room: a tap clicks there, a drag scrolls, and keys pressed while
/// it has focus go to it.
private struct Page: View {
    let frame: BrowserFrame?
    let inControl: Bool
    let browser: ObservedBrowser
    let tapped: () -> Void
    @State private var dragged: CGSize = .zero

    var body: some View {
        if let frame, frame.width > 0, frame.height > 0, let image = image(frame) {
            GeometryReader { geometry in
                Image(decorative: image, scale: 1)
                    .resizable()
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .opacity(inControl ? 1 : 0.85)
                    .contentShape(Rectangle())
                    .gesture(
                        SpatialTapGesture().onEnded { value in
                            guard inControl else { return }
                            let (x, y) = page(value.location, in: geometry.size, frame)
                            browser.click(x: x, y: y)
                            tapped()
                        }
                    )
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { value in
                                guard inControl else { return }
                                let scale = Double(frame.width) / geometry.size.width
                                let dx = (value.translation.width - dragged.width) * scale
                                let dy = (value.translation.height - dragged.height) * scale
                                dragged = value.translation
                                let (x, y) = page(value.location, in: geometry.size, frame)
                                browser.scroll(x: x, y: y, dx: -dx, dy: -dy)
                            }
                            .onEnded { _ in dragged = .zero }
                    )
                    .focusable(inControl)
                    .onKeyPress(phases: .down) { press in key(press) }
            }
            .aspectRatio(CGFloat(frame.width) / CGFloat(frame.height), contentMode: .fit)
            .accessibilityLabel("The room's browser, at \(frame.url)")
        } else {
            Text("Waiting for the page…")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 240)
        }
    }

    private func image(_ frame: BrowserFrame) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(frame.jpeg as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private func page(_ point: CGPoint, in size: CGSize, _ frame: BrowserFrame) -> (Int, Int) {
        (Int(point.x / size.width * Double(frame.width)), Int(point.y / size.height * Double(frame.height)))
    }

    /// A hardware key: printable characters as text, the rest by their names.
    private func key(_ press: KeyPress) -> KeyPress.Result {
        guard inControl else { return .ignored }
        let named: [(KeyEquivalent, String)] = [
            (.return, "Enter"), (.delete, "Backspace"), (.tab, "Tab"), (.escape, "Escape"), (.deleteForward, "Delete"),
            (.home, "Home"), (.end, "End"), (.pageUp, "PageUp"), (.pageDown, "PageDown"), (.upArrow, "ArrowUp"),
            (.downArrow, "ArrowDown"), (.leftArrow, "ArrowLeft"), (.rightArrow, "ArrowRight"),
        ]
        if let name = named.first(where: { $0.0 == press.key })?.1 {
            browser.press(name)
            return .handled
        }
        if press.modifiers.contains(.command) || press.modifiers.contains(.control) {
            // Copy and paste in the page itself.
            browser.press("\(press.modifiers.contains(.control) ? "Control" : "Meta")+\(press.characters.uppercased())")
            return .handled
        }
        guard !press.characters.isEmpty else { return .ignored }
        browser.type(press.characters)
        return .handled
    }
}
