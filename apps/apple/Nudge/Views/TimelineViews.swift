import Nudge
import SwiftUI

/// One item of a room's timeline.
struct TimelineRow: View {
    let item: TimelineItem
    let me: String?
    let decide: (_ approval: String, _ approve: Bool) -> Void

    var body: some View {
        switch item {
        case .user(_, let text, let author, _, _, _):
            let mine = author == nil || author?.id == me
            MessageBubble(text: text, mine: mine, author: mine ? nil : author?.displayName)
        case .nudge(_, let text, let firedAt):
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(text)
                    Text(date(firedAt), style: .time).font(.caption).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "bell.fill").foregroundStyle(.orange)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 18))
        case .approval(_, let approvalId, let summary, let status, let decidedBy):
            ApprovalCard(summary: summary, status: status, decidedBy: decidedBy) { approve in
                decide(approvalId, approve)
            }
        case .answer(_, let status, let error, let parts):
            AnswerView(status: status, error: error, parts: parts)
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

struct MessageBubble: View {
    let text: String
    let mine: Bool
    /// Someone else's name, shown above their message.
    let author: String?

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
            if let author {
                Text(author).font(.caption).foregroundStyle(.secondary)
            }
            Text(text)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .foregroundStyle(mine ? Color.white : Color.primary)
                .glassEffect(mine ? .regular.tint(.accentColor) : .regular, in: .rect(cornerRadius: 20))
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, 40)
    }
}

/// The assistant's answer: its text, what it thought, and the tools it used, as they stream.
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
                case .tool(let tool):
                    ToolView(tool: tool)
                }
            }
            switch status {
            case .running where parts.isEmpty:
                ProgressView().controlSize(.small)
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

    /// Inline markdown (bold, code, links), with the text's own line breaks.
    private func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

extension EnvironmentValues {
    /// Opens the room's browser, to log in where it asks.
    @Entry var openBrowser: (() -> Void)?
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
                Text(tool.name).font(.callout.monospaced())
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
            Text(summary)
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
