import Foundation

extension Array where Element == TimelineItem {
    /// The chat itself: messages and what the assistant said. Tool calls, thinking, fired nudges
    /// and ended approvals are left to `activity`, except the browser waiting on a login and cards
    /// (ADR 27); pending
    /// approvals wait in the room's own bar. An answer with nothing left to say drops out once
    /// it is done.
    public var transcript: [TimelineItem] {
        compactMap { item in
            switch item {
            case .nudge, .approval:
                return nil
            case .answer(let id, let status, let error, let parts, let startedAt, let promptedBy, let privateTo):
                let kept = parts.filter {
                    switch $0 {
                    case .text: true
                    case .reasoning: false
                    case .tool(let tool): tool.needsLogin || tool.card != nil
                    }
                }
                // Someone else's private answer comes without parts, and stays as a line saying so.
                let othersPrivate = privateTo != nil && parts.isEmpty
                if kept.isEmpty && status == .done && !othersPrivate { return nil }
                return .answer(id: id, status: status, error: error, parts: kept, startedAt: startedAt, promptedBy: promptedBy, privateTo: privateTo)
            case .user, .marker:
                return item
            }
        }
    }

    /// What happened behind the chat, oldest first: fired nudges and watches, ended approvals,
    /// and each answer's tool calls and thinking (its text stays in the chat).
    public var activity: [TimelineItem] {
        compactMap { item in
            switch item {
            case .nudge, .approval:
                return item
            case .answer(let id, let status, let error, let parts, let startedAt, let promptedBy, let privateTo):
                let kept = parts.filter {
                    if case .text = $0 { return false }
                    return true
                }
                return kept.isEmpty ? nil : .answer(id: id, status: status, error: error, parts: kept, startedAt: startedAt, promptedBy: promptedBy, privateTo: privateTo)
            case .user, .marker:
                return nil
            }
        }
    }

    /// The items each day of the transcript starts with, by id, with their time in ms since the
    /// epoch; days in `calendar`'s time zone. Items without a time don't start one.
    public func dayStarts(in calendar: Calendar = .current) -> [String: Double] {
        var starts: [String: Double] = [:]
        var day: Date?
        for item in self {
            guard let at = item.time else { continue }
            let its = calendar.startOfDay(for: Date(timeIntervalSince1970: at / 1000))
            if its != day { starts[item.id] = at }
            day = its
        }
        return starts
    }
}

extension TimelineItem {
    /// When it happened, in ms since the epoch: a message when it was sent, an answer when it
    /// started, a nudge when it fired.
    public var time: Double? {
        switch self {
        case .user(_, _, _, let sentAt, _, _, _): sentAt
        case .answer(_, _, _, _, let startedAt, _, _): startedAt
        case .nudge(_, _, let firedAt, _): firedAt
        case .approval, .marker: nil
        }
    }
}
