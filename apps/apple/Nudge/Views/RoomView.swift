import Nudge
import SwiftUI

/// A room: its timeline as it streams, this device's messages on their way, and the composer.
struct RoomView: View {
    let client: NudgeClient
    let roomId: String
    let me: String?
    /// The assistant's display name, over its answers.
    let assistant: String
    @State private var observed: ObservedRoom?
    @State private var draft = ""
    @State private var secret = false
    @State private var showing: Sheet?
    @State private var activity = false
    @State private var problem: String?
    /// The composer's dictation, here so the robot listens along.
    @State private var dictation = Dictation()
    /// How the last turn ended, shown for a moment while nothing else goes on.
    @State private var afterglow: Mood?
    /// The time, again every minute: enough to notice the room going quiet.
    @State private var now = Date.now

    enum Sheet: String, Identifiable {
        case info, browser
        var id: String { rawValue }
    }

    var body: some View {
        content
            .navigationTitle(state?.room?.name ?? "")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Activity", systemImage: "list.bullet.rectangle") { activity.toggle() }
                        .help("Tool calls, nudges, watches and approvals")
                    Button("Room", systemImage: "info.circle") { showing = .info }
                }
            }
            .sheet(item: $showing) { sheet in
                switch sheet {
                case .info: RoomInfoView(client: client, roomId: roomId, observed: observed)
                case .browser: PanelSheet { BrowserView(client: client, roomId: roomId) }
                }
            }
            // Behind the transcript: from the right on macOS, a sheet on iOS.
            .inspector(isPresented: $activity) {
                ActivityView(observed: observed)
                    .inspectorColumnWidth(min: 300, ideal: 380, max: 560)
                    #if os(iOS)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    #endif
            }
            .environment(\.openBrowser, { showing = .browser })
            .environment(\.openActivity, { activity = true })
            .alert("Something went wrong", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") { problem = nil }
            } message: {
                Text(problem ?? "")
            }
            // Let go of when the view goes, not on disappear: in a collapsed split view, the
            // room opened again can appear before it disappeared from the last time, which
            // left it with nothing observed and loading for good.
            .onAppear { if observed == nil { observed = client.observeRoomState(roomId) } }
            .onChange(of: RoomMood.lastAnswerMark(state?.timeline ?? [])) { before, after in
                afterglow = RoomMood.afterglow(from: before, to: after)
            }
            .task(id: afterglow) {
                guard let afterglow else { return }
                try? await Task.sleep(for: .seconds(RoomMood.duration(afterglow)))
                if !Task.isCancelled { self.afterglow = nil }
            }
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(60))
                    now = .now
                }
            }
    }

    private var state: RoomState? { observed?.value }

    /// The robot's mood, with a moment of joy or gloom when a turn ends while watching.
    private var mood: Mood {
        let mood = RoomMood.of(
            timeline: state?.timeline ?? [], live: state?.live, approvals: state?.approvals ?? [],
            now: now.timeIntervalSince1970 * 1000, listening: dictation.phase == .listening)
        if let afterglow, mood == .idle { return afterglow }
        return mood
    }

    /// The microphone's loudness while dictating, for the robot to follow.
    private var level: (@MainActor () -> Double)? {
        guard dictation.phase == .listening else { return nil }
        return { [dictation] in Double(dictation.level) }
    }

    /// Nothing said in the room yet, nor on its way.
    private var empty: Bool {
        transcript.isEmpty && queued.isEmpty && (state?.pending.isEmpty ?? true)
    }

    @ViewBuilder private var content: some View {
        if let state, state.status == .gone {
            ContentUnavailableView(
                state.reason == .removed ? "You left this room" : "No such room",
                systemImage: "questionmark.bubble")
        } else {
            // The timeline scrolls under a floating glass bar: what waits for approval, the live
            // status, and the composer, sampled as one glass surface.
            timeline
                .safeAreaBar(edge: .bottom) {
                    GlassEffectContainer(spacing: 8) {
                        VStack(spacing: 8) {
                            // Asked for by a tool and waiting: the activity shows them once decided.
                            ForEach(state?.approvals.filter { $0.status == .pending } ?? [], id: \.id) { approval in
                                ApprovalCard(summary: approval.summary, status: approval.status, decidedBy: nil) { approve in
                                    decide(approval.id, approve)
                                }
                            }
                            if !empty {
                                Presence(
                                    mood: mood, level: level, status: state?.live?.status,
                                    label: RoomMood.label(mood, timeline: state?.timeline ?? [], live: state?.live))
                            } else if let status = state?.live?.status {
                                LiveStatusView(status: status)
                            }
                            Composer(
                                draft: $draft, running: state?.live?.running == true, dictation: dictation,
                                // Only in a shared room is there anyone to keep a message from.
                                secret: state?.room?.kind == .personal ? nil : $secret,
                                send: { text in Task { await send(text) } },
                                stop: { Task { await attempt { try await client.abort(room: roomId) } } })
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 8)
                    }
                    .animation(.smooth, value: state?.approvals.map(\.status))
                }
        }
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Not lazy: the view's window is at most 100 items, plus the pages loaded on
                // demand, and on iOS a LazyVStack pinned to the bottom re-estimates its rows'
                // heights against the anchor until the app hangs.
                VStack(alignment: .leading, spacing: 14) {
                    if let state, state.canLoadEarlier || state.loadingEarlier {
                        Button {
                            Task { await observed?.loadEarlier() }
                        } label: {
                            if state.loadingEarlier { ProgressView().controlSize(.small) } else { Text("Load earlier") }
                        }
                        .buttonStyle(.glass)
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                    }
                    if let error = state?.earlierError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                    // Tool calls, nudges and ended approvals are in the activity.
                    let transcript = transcript
                    let days = transcript.dayStarts()
                    ForEach(transcript, id: \.id) { item in
                        if let day = days[item.id] { DayDivider(at: day) }
                        TimelineRow(item: item, me: me, assistant: assistant)
                    }
                    ForEach(queued, id: \.id) { message in
                        let mine = message.author == nil || message.author?.id == me
                        MessageBubble(text: message.text, mine: mine, author: mine ? nil : message.author?.displayName)
                            .opacity(0.6)
                            .overlay(alignment: .bottomTrailing) {
                                Text(message.mode == .steer ? "next" : "queued")
                                    .font(.caption2).foregroundStyle(.secondary).offset(y: 14)
                            }
                    }
                    ForEach(state?.pending ?? [], id: \.requestId) { pending in
                        PendingRow(
                            message: pending,
                            retry: { Task { await attempt { _ = try await client.resend(room: roomId, requestId: pending.requestId) } } },
                            dismiss: { client.dismiss(room: roomId, requestId: pending.requestId) })
                    }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding()
                .textSelection(.enabled)
            }
            .defaultScrollAnchor(.bottom)
            .scrollEdgeEffectStyle(.soft, for: .all)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: scrollKey) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            .overlay {
                if state == nil || (state?.room == nil && state?.status == .syncing) {
                    ProgressView()
                } else if empty {
                    VStack(spacing: 12) {
                        AvatarView(mood: mood, size: 160, level: level)
                        Text("Say hello to \(assistant).").foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private static let bottom = "bottom"

    private var transcript: [TimelineItem] { state?.timeline.transcript ?? [] }

    /// What changes when the bottom of the timeline does: follow it.
    private var scrollKey: [String] {
        guard let state else { return [] }
        let transcript = transcript
        var key = [transcript.last.map(answerLength) ?? "", "\(transcript.count)"]
        key.append("\(state.pending.count)/\(state.queue.count)")
        return key
    }

    private func answerLength(_ item: TimelineItem) -> String {
        guard case .answer(let id, _, _, let parts, _, _, _) = item else { return item.id }
        return "\(id):\(parts.count):\(parts.last.map(partLength) ?? 0)"
    }

    private func partLength(_ part: Part) -> Int {
        switch part {
        case .text(let text), .reasoning(let text): text.count
        case .tool(let tool): (tool.output?.count ?? 0) + (tool.result?.count ?? 0)
        }
    }

    /// Others' queued messages and this device's that went through, waiting for the answer.
    private var queued: [QueuedMessage] {
        let pending = Set(state?.pending.map(\.requestId) ?? [])
        return (state?.queue ?? []).filter { !$0.nudge && !pending.contains($0.requestId ?? "") }
    }

    private func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        draft = ""
        let isPrivate = secret && state?.room?.kind != .personal
        // A refused message stays in `pending`, marked failed, with Retry and Dismiss.
        _ = try? await client.send(room: roomId, text: trimmed, whenBusy: nil, private: isPrivate)
    }

    private func decide(_ approval: String, _ approve: Bool) {
        Task { await attempt { _ = try await client.decide(room: roomId, approvalId: approval, approve: approve) } }
    }

    private func attempt(_ action: () async throws -> Void) async {
        do {
            try await action()
        } catch {
            problem = explain(error)
        }
    }
}

/// The message field and Send, or Stop while the assistant answers and the field is empty; the
/// button morphs between the two. The mic in the field dictates: what the player says goes after
/// what they typed, written out on this device.
struct Composer: View {
    @Binding var draft: String
    let running: Bool
    /// The mic's: its room's, which the robot follows.
    let dictation: Dictation
    /// Whether the next message is private; nil where there is nobody to keep it from.
    var secret: Binding<Bool>?
    let send: (String) -> Void
    let stop: () -> Void
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    @Namespace private var glass
    /// Whether the field shows a dictation: typing takes over from it.
    @State private var dictating = false
    /// The draft when dictation started, and the draft it wrote last.
    @State private var before = ""
    @State private var written = ""
    @State private var offerDownload = false
    @State private var problem: String?

    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if let secret {
                Toggle(isOn: secret) {
                    Image(systemName: secret.wrappedValue ? "lock.fill" : "lock.open").frame(width: 24, height: 24)
                }
                .toggleStyle(.button)
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .controlSize(.large)
                .accessibilityLabel(secret.wrappedValue ? "Private: only you see it and the answer" : "Send privately")
            }
            HStack(alignment: .bottom, spacing: 4) {
                TextField(secret?.wrappedValue == true ? "Private message" : "Message", text: $draft, axis: .vertical)
                    .lineLimit(1...8)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .padding(.vertical, 11)
                    #if os(macOS)
                    .onKeyPress(.return, phases: .down) { press in
                        // Return sends; Shift-Return starts a new line.
                        if press.modifiers.contains(.shift) { return .ignored }
                        submit()
                        return .handled
                    }
                    #endif
                mic.padding(.bottom, 5)
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
            if running && draft.isEmpty {
                Button(action: stop) {
                    Image(systemName: "stop.fill").frame(width: 24, height: 24)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(.red)
                .controlSize(.large)
                .glassEffectID("action", in: glass)
                .accessibilityLabel("Stop")
                .keyboardShortcut(".", modifiers: .command)
            } else {
                Button(action: submit) {
                    Image(systemName: "arrow.up").fontWeight(.semibold).frame(width: 24, height: 24)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .controlSize(.large)
                .disabled(empty)
                .glassEffectID("action", in: glass)
                .accessibilityLabel("Send")
            }
        }
        .animation(.smooth, value: running && draft.isEmpty)
        .onChange(of: dictation.text) { _, heard in
            if dictating { write(heard) }
        }
        .onChange(of: dictation.phase) { _, phase in
            // Done: the last words, which may come with it.
            if phase == .idle, dictating {
                write(dictation.text)
                dictating = false
            }
        }
        .onChange(of: draft) { _, now in
            // Typed into, or sent: the dictation stops, and what it heard stays.
            if dictating, now != written {
                dictating = false
                dictation.cancel()
            }
        }
        .onDisappear { dictation.cancel() }
        .confirmationDialog("Dictate on this device?", isPresented: $offerDownload, titleVisibility: .visible) {
            Button("Download \(megabytes(model.speech.model?.bytes ?? 0))") {
                Task {
                    await model.speech.download(model.speech.modelId)
                    if model.speech.ready { dictate() } else { problem = model.speech.problem }
                }
            }
        } message: {
            Text("Nudge writes out what you say on this device, so your voice never leaves it. It needs a speech model for that (\(model.speech.model?.name ?? "")), downloaded once. Settings has others.")
        }
        .alert("Dictation stopped", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK") { problem = nil }
        } message: {
            Text(problem ?? "")
        }
    }

    /// The mic, its download's progress, or the dictation going on with the language it hears.
    @ViewBuilder private var mic: some View {
        let speech = model.speech
        if let progress = speech.downloading[speech.modelId] {
            ProgressView(value: progress)
                .progressViewStyle(.circular)
                .controlSize(.small)
                .frame(width: 30, height: 30)
                .accessibilityLabel("Downloading the speech model")
        } else {
            HStack(spacing: 2) {
                if dictation.phase == .listening, let language = dictation.language {
                    Text(language.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                }
                Button(action: tapMic) {
                    switch dictation.phase {
                    case .idle:
                        Image(systemName: "mic")
                    case .loading, .finishing:
                        ProgressView().controlSize(.small)
                    case .listening:
                        Image(systemName: "mic.fill")
                            .foregroundStyle(.red)
                            .scaleEffect(1 + 0.25 * CGFloat(dictation.level))
                            .animation(.easeOut(duration: 0.1), value: dictation.level)
                    }
                }
                .buttonStyle(.plain)
                .frame(width: 30, height: 30)
                .contentShape(.rect)
                .accessibilityLabel(dictation.phase == .idle ? "Dictate" : "Stop dictating")
            }
        }
    }

    private func tapMic() {
        switch dictation.phase {
        case .idle:
            if model.speech.ready { dictate() } else { offerDownload = true }
        case .loading, .listening:
            dictation.stop()
        case .finishing:
            break
        }
    }

    private func dictate() {
        before = draft
        written = draft
        dictating = true
        Task {
            do {
                try await dictation.start(model.speech)
            } catch {
                dictating = false
                problem = error.localizedDescription
            }
        }
    }

    /// Puts what was heard after what was typed before the dictation.
    private func write(_ heard: String) {
        let text = [before.trimmingCharacters(in: .whitespacesAndNewlines), heard]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        written = text
        draft = text
    }

    private func submit() {
        if dictating {
            dictating = false
            dictation.cancel()
        }
        send(draft)
    }
}

/// The robot, live, by the composer, and a word on what it is doing: the live status when there is
/// one.
struct Presence: View {
    let mood: Mood
    let level: (@MainActor () -> Double)?
    let status: Status?
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            AvatarView(mood: mood, size: 40, level: level)
            if let status {
                LiveStatusView(status: status)
            } else if !label.isEmpty {
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .animation(.smooth, value: label)
    }
}

/// Retrying after a model error, or compacting a long conversation.
struct LiveStatusView: View {
    let status: Status

    var body: some View {
        HStack(spacing: 6) {
            switch status {
            case .retrying(let attempt, _, let error):
                ProgressView().controlSize(.small)
                Text("Trying again (\(attempt)): \(error)").lineLimit(2)
            case .compacting:
                ProgressView().controlSize(.small)
                Text("Summarizing the conversation so far…")
            case .compactionFailed(let error):
                Image(systemName: "exclamationmark.triangle")
                Text("Couldn't summarize: \(error)").lineLimit(2)
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(in: .capsule)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PendingRow: View {
    let message: PendingMessage
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            MessageBubble(text: message.text, mine: true, author: nil).opacity(0.6)
            switch message.state {
            case .sending:
                Label("Sending", systemImage: "arrow.up.circle").font(.caption).foregroundStyle(.secondary)
            case .waiting:
                Label("Waiting for the connection", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
            case .failed(let error):
                VStack(alignment: .trailing, spacing: 6) {
                    Label("Not sent: \(error)", systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.red)
                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            Button("Retry", systemImage: "arrow.clockwise", action: retry)
                                .buttonStyle(.glassProminent)
                            Button("Dismiss", role: .destructive, action: dismiss)
                                .buttonStyle(.glass)
                        }
                    }
                    .controlSize(.small)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A panel of the room's on its own, as a sheet with Done.
struct PanelSheet<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    @ViewBuilder let content: Content

    var body: some View {
        NavigationStack {
            content.toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 600)
        #endif
    }
}
