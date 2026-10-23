// What the robot shows for a room, from what is going on in it. As the web's `mood.ts`.
import Foundation
import Nudge

enum RoomMood {
    /// After this long with nothing said in the room, in ms, the robot dozes off.
    static let asleepAfter: Double = 30 * 60_000

    /// The mood of a room at `now` (ms since the epoch): someone dictating, an approval waiting,
    /// the turn running and what it is doing, or how long it has been quiet. How a turn ended is
    /// `ended`'s to say.
    static func of(
        timeline: [TimelineItem], live: Live?, approvals: [Approval], now: Double, listening: Bool = false
    ) -> Mood {
        if listening { return .listening }
        if approvals.contains(where: { $0.status == .pending }) { return .waiting }
        switch live?.status {
        case .retrying: return .puzzled
        case .compacting: return .thinking
        default: break
        }
        if live?.running == true {
            var last: Part?
            if case .answer(_, .running, _, let parts, _, _, _)? = lastAnswer(timeline) { last = parts.last }
            switch last {
            case .tool(let tool)? where tool.status != .done: return .working
            case .text(let text)? where !text.isEmpty: return .speaking
            default: return .thinking
            }
        }
        return now - lastSaid(timeline) > asleepAfter ? .asleep : .idle
    }

    /// The room's last answer, and how it stands, to tell when a turn ends.
    static func lastAnswerMark(_ timeline: [TimelineItem]) -> AnswerMark? {
        guard case .answer(let id, let status, _, _, _, _, _)? = lastAnswer(timeline) else { return nil }
        return AnswerMark(id: id, status: status)
    }

    /// The mood a turn ends with, shown for a moment, when the room's last answer goes from
    /// running to `status`; nil while it runs, or for a stopped one.
    static func ended(_ status: AnswerStatus) -> Mood? {
        switch status {
        case .done: .happy
        case .failed: .sad
        case .running, .stopped: nil
        }
    }

    /// The end of a turn to show when the last answer goes from `before` to `after`: only when the
    /// same answer stopped running.
    static func afterglow(from before: AnswerMark?, to after: AnswerMark?) -> Mood? {
        guard let before, let after, before.id == after.id, before.status == .running else { return nil }
        return ended(after.status)
    }

    /// How long the end of a turn shows, in seconds.
    static func duration(_ mood: Mood) -> Double {
        switch mood {
        case .happy: 1.6
        case .sad: 4
        default: 0
        }
    }

    /// A word on what the robot is doing, beside it; nothing when that is plain to see.
    static func label(_ mood: Mood, timeline: [TimelineItem], live: Live?) -> String {
        switch mood {
        case .working:
            if case .answer(_, _, _, let parts, _, _, _)? = lastAnswer(timeline), case .tool(let tool)? = parts.last {
                return "Using \(tool.name)…"
            }
            return "Working…"
        case .thinking:
            if case .compacting? = live?.status { return "Tidying up older messages…" }
            return "Thinking…"
        case .speaking: return "Answering…"
        case .waiting: return "Waiting for an approval"
        case .puzzled: return "Trying again…"
        case .sad: return "That didn't work"
        case .asleep: return "Dozing"
        case .happy, .idle, .listening: return ""
        }
    }

    private static func lastAnswer(_ timeline: [TimelineItem]) -> TimelineItem? {
        timeline.last {
            if case .answer = $0 { return true }
            return false
        }
    }

    /// When something was last said in the room, in ms since the epoch.
    private static func lastSaid(_ timeline: [TimelineItem]) -> Double {
        // Messages when sent, answers when started, nudges when fired.
        let at = timeline.compactMap(\.time).max() ?? 0
        // A room with no times at all is a new one, not a sleepy one.
        return at == 0 ? .infinity : at
    }
}

struct AnswerMark: Equatable, Sendable {
    var id: String
    var status: AnswerStatus
}
