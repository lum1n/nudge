// `nudge://join?server=…&assistant=…`, as an admin's invite of someone from another assistant makes them.
import Foundation

/// What a join link says: the assistant to join, from the player's home, and its server.
public struct JoinLink: Equatable, Identifiable, Sendable {
    public var server: String
    public var assistant: String

    public var id: String { "\(server)|\(assistant)" }

    public init(server: String, assistant: String) {
        self.server = server
        self.assistant = assistant
    }

    /// Nil for anything but a join link with an http(s) server and an assistant.
    public init?(_ url: URL) {
        guard url.scheme?.lowercased() == "nudge", url.host?.lowercased() == "join",
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespaces)
        }
        guard let server = value("server"), let scheme = URL(string: server)?.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let assistant = value("assistant"), !assistant.isEmpty
        else { return nil }
        self.init(server: server, assistant: assistant)
    }
}
