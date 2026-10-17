extension Array where Element == TimelineItem {
    /// The chat itself: messages and what the assistant said. Tool calls, thinking, fired nudges
    /// and ended approvals are left to `activity`, except the browser waiting on a login; pending
    /// approvals wait in the room's own bar. An answer with nothing left to say drops out once
    /// it is done.
    public var transcript: [TimelineItem] {
        compactMap { item in
            switch item {
            case .nudge, .approval:
                return nil
            case .answer(let id, let status, let error, let parts, let privateTo):
                let kept = parts.filter {
                    switch $0 {
                    case .text: true
                    case .reasoning: false
                    case .tool(let tool): tool.needsLogin
                    }
                }
                // Someone else's private answer comes without parts, and stays as a line saying so.
                let othersPrivate = privateTo != nil && parts.isEmpty
                if kept.isEmpty && status == .done && !othersPrivate { return nil }
                return .answer(id: id, status: status, error: error, parts: kept, privateTo: privateTo)
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
            case .answer(let id, let status, let error, let parts, let privateTo):
                let kept = parts.filter {
                    if case .text = $0 { return false }
                    return true
                }
                return kept.isEmpty ? nil : .answer(id: id, status: status, error: error, parts: kept, privateTo: privateTo)
            case .user, .marker:
                return nil
            }
        }
    }
}
