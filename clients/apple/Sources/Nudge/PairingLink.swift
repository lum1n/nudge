// `nudge://pair?server=…&assistant=…&code=…`, as `nudge pair` and the admin API make them.
import Foundation

/// What a pairing link says: where the server is, which assistant, and the one-time code.
public struct PairingLink: Equatable, Identifiable, Sendable {
    public var server: String
    public var assistant: String
    public var code: String

    public var id: String { "\(server)|\(assistant)|\(code)" }

    public init(server: String, assistant: String, code: String) {
        self.server = server
        self.assistant = assistant
        self.code = code
    }

    /// Nil for anything but a pairing link with an http(s) server, an assistant and a code.
    public init?(_ url: URL) {
        guard url.scheme?.lowercased() == "nudge", url.host?.lowercased() == "pair",
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespaces)
        }
        guard let server = value("server"), let scheme = URL(string: server)?.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let assistant = value("assistant"), !assistant.isEmpty,
            let code = value("code"), !code.isEmpty
        else { return nil }
        self.init(server: server, assistant: assistant, code: code)
    }
}
