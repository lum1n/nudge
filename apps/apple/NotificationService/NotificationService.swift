// Pushes through a push relay arrive as "New message", with the real one sealed for this device
// beside `aps`. This opens it before it is shown, and gives it the keys a direct push has, so a
// tap opens the room as usual. One it can't open is shown as it came.
import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let sealed = request.content.userInfo["sealed"] as? String,
            let privateKey = PushKey.storedPrivateKey,
            let opened = PushKey.open(sealed, privateKey: privateKey),
            let content = request.content.mutableCopy() as? UNMutableNotificationContent
        else { return contentHandler(request.content) }
        content.title = opened.title
        content.body = opened.body
        content.threadIdentifier = opened.tag
        var info = content.userInfo
        info.removeValue(forKey: "sealed")
        info["assistant"] = opened.assistant
        info["roomId"] = opened.roomId
        info["kind"] = opened.kind
        info["url"] = opened.url
        content.userInfo = info
        contentHandler(content)
    }
}
