import Nudge
import SwiftUI

/// What happened behind a room's transcript, newest first: the tools the assistant called and
/// what it thought, nudges and watches that fired, and approvals that ended. An inspector:
/// sliding in from the right on macOS, a sheet on iOS.
struct ActivityView: View {
    let observed: ObservedRoom?

    private var state: RoomState? { observed?.value }

    // No navigation stack of its own: on iOS its title and toolbar ended up in the room's bar.
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                let items = Array((state?.timeline ?? []).activity.reversed())
                if items.isEmpty {
                    ContentUnavailableView(
                        "Nothing yet", systemImage: "list.bullet.rectangle",
                        description: Text("Tool calls, nudges, watches and approvals show up here."))
                }
                ForEach(items, id: \.id) { item in
                    ActivityRow(item: item)
                }
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
            }
            .padding()
            .textSelection(.enabled)
        }
    }
}

/// One thing in the activity.
struct ActivityRow: View {
    let item: TimelineItem

    var body: some View {
        switch item {
        case .nudge(_, let text, _, let privateTo?) where text.isEmpty:
            PrivateLine(text: "A nudge for \(privateTo.displayName)")
        case .nudge(_, let text, let firedAt, _):
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(hidingValues(text))
                    Text(date(firedAt), format: .dateTime.day().month().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "bell.fill").foregroundStyle(.orange)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 18))
        case .approval(_, _, let summary, _, _, let privateTo?) where summary.isEmpty:
            PrivateLine(text: "An approval for \(privateTo.displayName) ended")
        case .approval(_, _, let summary, let status, let decidedBy, _):
            // Ended: nothing left to decide.
            ApprovalCard(summary: summary, status: status, decidedBy: decidedBy) { _ in }
        case .answer(_, let status, let error, let parts, _, _, _):
            AnswerView(status: status, error: error, parts: parts)
        case .user, .marker:
            EmptyView()
        }
    }
}
