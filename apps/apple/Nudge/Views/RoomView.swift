import Nudge
import SwiftUI

/// A room: its timeline as it streams, this device's messages on their way, and the composer.
struct RoomView: View {
    let client: NudgeClient
    let roomId: String
    let me: String?
    @State private var observed: ObservedRoom?
    @State private var draft = ""
    @State private var secret = false
    @State private var showing: Sheet?
    @State private var problem: String?

    enum Sheet: String, Identifiable {
        case lists, info, browser
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
                    Button("Lists", systemImage: "checklist") { showing = .lists }
                    Button("Room", systemImage: "info.circle") { showing = .info }
                }
            }
            .sheet(item: $showing) { sheet in
                switch sheet {
                case .lists: ListsView(client: client, roomId: roomId)
                case .info: RoomInfoView(client: client, roomId: roomId, observed: observed)
                case .browser: PanelSheet { BrowserView(client: client, roomId: roomId) }
                }
            }
            .environment(\.openBrowser, { showing = .browser })
            .alert("Something went wrong", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") { problem = nil }
            } message: {
                Text(problem ?? "")
            }
            // Let go of when the view goes, not on disappear: in a collapsed split view, the
            // room opened again can appear before it disappeared from the last time, which
            // left it with nothing observed and loading for good.
            .onAppear { if observed == nil { observed = client.observeRoomState(roomId) } }
    }

    private var state: RoomState? { observed?.value }

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
                            // Asked for by a tool and waiting: the timeline shows them once decided.
                            ForEach(state?.approvals.filter { $0.status == .pending } ?? [], id: \.id) { approval in
                                ApprovalCard(summary: approval.summary, status: approval.status, decidedBy: nil) { approve in
                                    decide(approval.id, approve)
                                }
                            }
                            if let status = state?.live?.status { LiveStatusView(status: status) }
                            Composer(
                                draft: $draft, running: state?.live?.running == true,
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
                    ForEach(state?.timeline ?? [], id: \.id) { item in
                        TimelineRow(item: item, me: me, decide: decide)
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
                if state == nil || (state?.room == nil && state?.status == .syncing) { ProgressView() }
            }
        }
    }

    private static let bottom = "bottom"

    /// What changes when the bottom of the timeline does: follow it.
    private var scrollKey: [String] {
        guard let state else { return [] }
        var key = [state.timeline.last.map(answerLength) ?? "", "\(state.timeline.count)"]
        key.append("\(state.pending.count)/\(state.queue.count)")
        return key
    }

    private func answerLength(_ item: TimelineItem) -> String {
        guard case .answer(let id, _, _, let parts, _) = item else { return item.id }
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
/// button morphs between the two.
struct Composer: View {
    @Binding var draft: String
    let running: Bool
    /// Whether the next message is private; nil where there is nobody to keep it from.
    var secret: Binding<Bool>?
    let send: (String) -> Void
    let stop: () -> Void
    @FocusState private var focused: Bool
    @Namespace private var glass

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
            TextField(secret?.wrappedValue == true ? "Private message" : "Message", text: $draft, axis: .vertical)
                .lineLimit(1...8)
                .textFieldStyle(.plain)
                .focused($focused)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
                #if os(macOS)
                .onKeyPress(.return, phases: .down) { press in
                    // Return sends; Shift-Return starts a new line.
                    if press.modifiers.contains(.shift) { return .ignored }
                    send(draft)
                    return .handled
                }
                #endif
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
                Button { send(draft) } label: {
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
