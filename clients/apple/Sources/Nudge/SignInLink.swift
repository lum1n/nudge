// `nudge://sign-in?server=…&request=…`, as the web UI's sign-in page shows them in a QR code.
import Foundation

/// What a sign-in link says: the server whose web UI shows it, and the browser's request there,
/// which an app signed in to that server approves with `NudgeClient.approveSignIn`.
public struct SignInLink: Equatable, Identifiable, Sendable {
    public var server: String
    public var request: String

    public var id: String { "\(server)|\(request)" }

    public init(server: String, request: String) {
        self.server = server
        self.request = request
    }

    /// Nil for anything but a sign-in link with an http(s) server and a request.
    public init?(_ url: URL) {
        guard url.scheme?.lowercased() == "nudge", url.host?.lowercased() == "sign-in",
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespaces)
        }
        guard let server = value("server"), let scheme = URL(string: server)?.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let request = value("request"), !request.isEmpty
        else { return nil }
        self.init(server: server, request: request)
    }
}
