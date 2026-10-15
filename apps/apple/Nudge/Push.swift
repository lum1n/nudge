// Notifications: permission, the APNs device token, and what happens when one arrives or is
// tapped. The server pushes only while the app has the room closed: the app disconnects in the
// background, and a notification for the room on screen isn't shown.
import Foundation
import Nudge
import UserNotifications

#if os(iOS)
import UIKit
#else
import AppKit
#endif

enum Push {
    #if DEBUG
    /// Builds run from Xcode get their pushes through Apple's sandbox.
    static let environment = PushEnvironment.sandbox
    #else
    static let environment = PushEnvironment.production
    #endif

    #if os(iOS)
    static let platformName = "ios"
    #else
    static let platformName = "macos"
    #endif

    /// Asks once, after signing in; registers with APNs when allowed.
    static func requestPermission() {
        Task { @MainActor in
            let granted = try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            if granted == true { register() }
        }
    }

    /// Registers with APNs on every start when allowed: the token can change.
    static func registerIfAllowed() {
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                register()
            }
        }
    }

    @MainActor
    private static func register() {
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }
}

/// Hands push events to the model; also the notification center's delegate.
@MainActor
final class AppDelegate: NSObject, UNUserNotificationCenterDelegate {
    let model = AppModel()

    func notificationsReady() {
        UNUserNotificationCenter.current().delegate = self
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let room = notification.request.content.userInfo["roomId"] as? String
        return await MainActor.run {
            room != nil && room == model.selectedRoom ? [] : [.banner, .list, .sound]
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let assistant = info["assistant"] as? String
        let room = info["roomId"] as? String
        await MainActor.run { model.open(assistant: assistant, room: room) }
    }
}

#if os(iOS)
extension AppDelegate: UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        notificationsReady()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        model.didRegisterForPush(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No pushes, as on the simulator without a team; the app works without.
    }
}
#else
extension AppDelegate: NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        notificationsReady()
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        model.didRegisterForPush(deviceToken: deviceToken)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No pushes, as when the app isn't signed; the app works without.
    }
}
#endif
