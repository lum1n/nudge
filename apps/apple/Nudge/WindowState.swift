import Nudge
import SwiftUI

/// One window's own state: the room it shows, whether it is on screen, and the links opened in
/// it. The iPad, the Mac and the iPhone Duo's inner display run several windows of the app, and
/// each picks its own room.
@MainActor @Observable
final class WindowState {
    /// The room on screen here, also chosen by tapping a notification.
    var selectedRoom: RoomRef?
    /// This window's scene phase; the app keeps its sockets while any window is not in the
    /// background.
    var phase: ScenePhase = .background
    /// A pairing link opened while signed out, or for another server.
    var pendingLink: PairingLink?
    /// A join link: an admin elsewhere invited the player.
    var pendingJoin: JoinLink?
    /// A sign-in link from the QR code of a browser that shows the web UI.
    var pendingSignIn: SignInLink?

    init(selectedRoom: RoomRef? = nil) {
        self.selectedRoom = selectedRoom
    }
}
