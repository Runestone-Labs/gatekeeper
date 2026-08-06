import Foundation
import UserNotifications

/// Actionable notifications: Approve / Deny live in the banner itself, so a
/// decision doesn't require opening anything. Requires the executable to run
/// from a real .app bundle (see build-app.sh) — bare SPM binaries can't post
/// user notifications.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    static let categoryId = "GK_APPROVAL"
    static let expiredCategoryId = "GK_EXPIRED"

    /// Set by AppState; receives (holdID, approve?) from notification actions.
    var onDecision: ((String, Bool) -> Void)?

    private var available = false

    func setup() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let approve = UNNotificationAction(
            identifier: "APPROVE", title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: "DENY", title: "Deny",
            options: [.destructive, .authenticationRequired]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.categoryId, actions: [approve, deny],
                intentIdentifiers: [], options: []
            ),
            UNNotificationCategory(
                identifier: Self.expiredCategoryId, actions: [],
                intentIdentifiers: [], options: []
            ),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            self.available = granted
        }
    }

    func notifyHold(_ hold: PendingHold) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = "Approval required: \(hold.toolName)"
        content.subtitle = "agent: \(hold.actor.name)"
        content.body = String(hold.argsSummary.prefix(140))
        content.sound = .default
        content.categoryIdentifier = Self.categoryId
        content.userInfo = ["holdId": hold.id]
        let req = UNNotificationRequest(
            identifier: "hold-\(hold.id)", content: content, trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }

    /// Silence is the failure mode that killed the first four production holds
    /// — expiry gets its own loud notification instead of vanishing.
    func notifyExpired(_ hold: PendingHold) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = "Hold expired unanswered: \(hold.toolName)"
        content.subtitle = "agent: \(hold.actor.name)"
        content.body = "The agent's request was never decided and has expired."
        content.sound = .default
        content.categoryIdentifier = Self.expiredCategoryId
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "expired-\(hold.id)", content: content, trigger: nil)
        )
    }

    func clearHoldNotification(_ holdId: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: ["hold-\(holdId)"])
        center.removePendingNotificationRequests(withIdentifiers: ["hold-\(holdId)"])
    }

    // MARK: UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard let holdId = response.notification.request.content.userInfo["holdId"] as? String
        else { return }
        switch response.actionIdentifier {
        case "APPROVE": onDecision?(holdId, true)
        case "DENY": onDecision?(holdId, false)
        default: break // banner tap: the menu bar popover is the surface
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
