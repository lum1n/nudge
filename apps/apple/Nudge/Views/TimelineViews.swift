import Nudge
import SwiftUI

/// One item of a room's transcript: a message, an answer or a marker. Nudges and ended
/// approvals are in the activity (`ActivityView`).
struct TimelineRow: View {
    let item: TimelineItem
    let me: String?
    /// The assistant's display name, over each of its answers.
    let assistant: String
    /// How its robot looks, beside them.
    var look: RobotLook = .nudge

    var body: some View {
        switch item {
        // Someone else's private message: the server sent it empty, so it is a line, not a bubble.
        case .user(_, let text, _, _, _, _, let privateTo?, let attachments) where text.isEmpty && attachments.isEmpty:
            PrivateLine(text: "\(privateTo.displayName) sent a private message")
        case .user(_, let text, let author, let sentAt, _, _, let privateTo, let attachments):
            let mine = author == nil || author?.id == me
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                if privateTo != nil { OnlyYou() }
                if !attachments.isEmpty {
                    // The name goes over the files, the bubble under them without it.
                    if !mine, let author {
                        Text(author.displayName).font(.caption).foregroundStyle(.secondary)
                    }
                    MessageAttachments(attachments: attachments, mine: mine)
                }
                if !text.isEmpty || attachments.isEmpty {
                    MessageBubble(text: text, mine: mine, author: mine || !attachments.isEmpty ? nil : author?.displayName, sentAt: sentAt)
                }
            }
            .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        case .nudge, .approval:
            EmptyView()
        case .answer(_, let status, _, _, _, _, let privateTo?) where privateTo.id != me:
            PrivateLine(
                text: status == .running
                    ? "Answering \(privateTo.displayName) privately…" : "Answered \(privateTo.displayName) privately")
        case .answer(_, let status, let error, let parts, let startedAt, let promptedBy, let privateTo):
            // On a surface of its own, under the assistant's name, so it reads apart from the
            // messages around it and from the answer before. One no one asked for just now, to a
            // nudge or a watch, is tinted by what prompted it.
            VStack(alignment: .leading, spacing: 8) {
                AnswerHeader(name: assistant, startedAt: startedAt, promptedBy: promptedBy, appearance: look)
                if privateTo != nil { OnlyYou() }
                AnswerView(status: status, error: error, parts: parts)
            }
            .padding(14)
            .background {
                let shape = RoundedRectangle(cornerRadius: 22)
                if let promptedBy {
                    shape.fill(promptedBy.color.opacity(0.12))
                        .overlay(shape.strokeBorder(promptedBy.color.opacity(0.35)))
                } else {
                    shape.fill(.fill.quinary)
                }
            }
        case .marker(_, let kind):
            Text(kind == .compacted ? "Earlier messages summarized" : "Conversation started over")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .glassEffect(in: .capsule)
                .frame(maxWidth: .infinity)
        }
    }
}

func date(_ milliseconds: Double) -> Date {
    Date(timeIntervalSince1970: milliseconds / 1000)
}

extension PromptedBy {
    var label: String {
        switch self {
        case .nudge: "Nudge"
        case .watch: "Watch"
        }
    }

    var symbol: String {
        switch self {
        case .nudge: "bell.fill"
        case .watch: "eye.fill"
        }
    }

    var color: Color {
        switch self {
        case .nudge: .orange
        case .watch: .indigo
        }
    }
}

/// Whose answer it is, its robot at rest, when it started, and the nudge or watch that prompted it.
struct AnswerHeader: View {
    let name: String
    let startedAt: Double?
    var promptedBy: PromptedBy? = nil
    var appearance: RobotLook = .nudge

    var body: some View {
        HStack(spacing: 6) {
            Portrait(appearance: appearance, size: 20)
            Text(name).font(.subheadline.weight(.semibold))
            if let promptedBy {
                Label(promptedBy.label, systemImage: promptedBy.symbol)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(promptedBy.color)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(promptedBy.color.opacity(0.15), in: .capsule)
            }
            if let startedAt {
                Text(date(startedAt), format: .dateTime.hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Where a new day starts in the transcript: "Today", "Yesterday" or the date.
struct DayDivider: View {
    let at: Double

    var body: some View {
        HStack(spacing: 10) {
            line
            Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary).fixedSize()
            line
        }
        .padding(.vertical, 4)
    }

    private var line: some View { Rectangle().fill(.separator).frame(height: 1) }

    private var label: String {
        let day = date(at)
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "Today" }
        if calendar.isDateInYesterday(day) { return "Yesterday" }
        let thisYear = calendar.isDate(day, equalTo: .now, toGranularity: .year)
        let format = Date.FormatStyle.dateTime.weekday(.wide).day().month(.wide)
        return day.formatted(thisYear ? format : format.year())
    }
}

/// Something private to someone else happened here; the server didn't say what.
struct PrivateLine: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "lock.fill")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
    }
}

/// Marks what is the reader's alone, so they know the others don't see it.
struct OnlyYou: View {
    var body: some View {
        Label("Only you", systemImage: "lock.fill").font(.caption2).foregroundStyle(.purple)
    }
}

/// Text with each value the server hid (`⟦EMAIL1⟧` and the like) shown as "hidden".
func hidingValues(_ text: String) -> AttributedString {
    var shown = AttributedString()
    var rest = Substring(text)
    while let match = rest.firstMatch(of: /⟦[A-Z]+(?:\d+|:[a-z0-9\-]{1,24})⟧/) {
        shown += AttributedString(rest[..<match.range.lowerBound])
        var hidden = AttributedString(" hidden ")
        hidden.font = .callout.italic().monospaced()
        hidden.backgroundColor = .secondary.opacity(0.25)
        shown += hidden
        rest = rest[match.range.upperBound...]
    }
    return shown + AttributedString(rest)
}

struct MessageBubble: View {
    let text: String
    let mine: Bool
    /// Someone else's name, shown above their message.
    let author: String?
    /// When it was sent, in ms since the epoch, shown under it.
    var sentAt: Double? = nil

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
            if let author {
                Text(author).font(.caption).foregroundStyle(.secondary)
            }
            Text(hidingValues(text))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .foregroundStyle(mine ? Color.white : Color.primary)
                .glassEffect(mine ? .regular.tint(.accentColor) : .regular, in: .rect(cornerRadius: 20))
            if let sentAt {
                Text(date(sentAt), format: .dateTime.hour().minute())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, 40)
    }
}

/// The assistant's answer as it streams: its text in the transcript; what it thought and the
/// tools it used in the activity.
struct AnswerView: View {
    let status: AnswerStatus
    let error: String?
    let parts: [Part]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .text(let text):
                    Text(markdown(text))
                case .reasoning(let text):
                    DisclosureGroup("Thinking") {
                        Text(text).font(.callout).foregroundStyle(.secondary)
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))
                case .tool(let tool) where tool.needsLogin:
                    // The browser stopped for a login only a person can type.
                    LoginButton()
                case .tool(let tool) where tool.card != nil:
                    // A card a tool showed in the chat (ADR 27).
                    CardView(tool: tool, card: tool.card!)
                case .tool(let tool):
                    ToolView(tool: tool)
                }
            }
            switch status {
            case .running where parts.isEmpty:
                WorkingButton()
            case .stopped:
                Label("Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
            case .failed:
                Label(error ?? "Couldn't answer", systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.red)
            default:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Inline markdown (bold, code, links), with the text's own line breaks; hidden values as
    /// `hidden`, in code style.
    private func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        let marked = text.replacing(/⟦[A-Z]+(?:\d+|:[a-z0-9\-]{1,24})⟧/) { _ in "`hidden`" }
        return (try? AttributedString(markdown: marked, options: options)) ?? AttributedString(marked)
    }
}

extension EnvironmentValues {
    /// Opens the room's browser, to log in where it asks.
    @Entry var openBrowser: (() -> Void)?
}

extension EnvironmentValues {
    /// Opens the room's activity: the tool calls, nudges and approvals behind the transcript.
    @Entry var openActivity: (() -> Void)?
}

/// An answer at work with nothing to say yet; tapping it shows what it is doing.
struct WorkingButton: View {
    @Environment(\.openActivity) private var openActivity

    var body: some View {
        Button { openActivity?() } label: {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Working…")
            }
        }
        .buttonStyle(.plain)
        .font(.callout)
        .foregroundStyle(.secondary)
        .disabled(openActivity == nil)
    }
}

struct LoginButton: View {
    @Environment(\.openBrowser) private var openBrowser

    var body: some View {
        Button("Open the room's browser to log in", systemImage: "globe") { openBrowser?() }
            .buttonStyle(.glassProminent)
            .disabled(openBrowser == nil)
    }
}

struct ToolView: View {
    let tool: ToolPart
    @State private var open = false

    private var progress: String? {
        tool.output?.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty }.map { String($0.prefix(100)) }
    }

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 6) {
                if tool.argsJson != "{}" {
                    Text(tool.argsJson).font(.caption.monospaced())
                }
                if let output = tool.result ?? tool.output {
                    Text(output + (tool.truncated == true ? " …" : ""))
                        .font(.caption.monospaced())
                        .foregroundStyle(tool.isError == true ? .red : .secondary)
                        .lineLimit(30)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 6) {
                switch tool.status {
                case .pending, .running: ProgressView().controlSize(.mini)
                case .done:
                    Image(systemName: tool.isError == true ? "xmark.circle" : "checkmark.circle")
                        .foregroundStyle(tool.isError == true ? .red : .green)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(tool.name).font(.callout.monospaced())
                    // What a running tool is doing: its last printed line, like `Clicking "Search"…`.
                    if tool.status != .done, !open, let line = progress {
                        Text(line).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))
    }
}

/// An action the assistant wants to take, waiting for a member to approve it.
struct ApprovalCard: View {
    let summary: String
    let status: ApprovalStatus
    let decidedBy: String?
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(status == .pending ? "Needs approval" : "Approval", systemImage: "hand.raised.fill")
                .font(.caption.bold())
                .foregroundStyle(.orange)
            Text(hidingValues(summary))
            if status == .pending {
                GlassEffectContainer(spacing: 8) {
                    HStack(spacing: 8) {
                        Button("Approve", systemImage: "checkmark") { decide(true) }
                            .buttonStyle(.glassProminent)
                        Button("Deny", systemImage: "xmark", role: .destructive) { decide(false) }
                            .buttonStyle(.glass)
                    }
                }
            } else {
                Text(outcome).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(status == .pending ? 0.25 : 0.1)), in: .rect(cornerRadius: 22))
    }

    private var outcome: String {
        let by = decidedBy.map { " by \($0)" } ?? ""
        switch status {
        case .pending: return ""
        case .approved: return "Approved\(by)"
        case .denied: return "Denied\(by)"
        case .done: return "Approved\(by), done"
        case .failed: return "Approved\(by), but it failed"
        }
    }
}
