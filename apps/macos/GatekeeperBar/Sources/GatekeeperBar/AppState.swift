import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var pending: [PendingHold] = []
    @Published var serverUp = false
    @Published var today = TodayStats()
    @Published var lastError: String?
    @Published var configured: Bool

    @AppStorage("gatekeeperBaseURL") var baseURLString = "http://127.0.0.1:3847" {
        didSet { restartPolling() }
    }

    private var secret: String

    /// Hold IDs we've already notified about (avoid duplicate banners).
    private var notifiedIds: Set<String> = []
    /// IDs decided from this app (so their disappearance isn't "expiry").
    private var locallyDecidedIds: Set<String> = []

    private var pollTask: Task<Void, Never>?
    private var contextTask: Task<Void, Never>?

    init() {
        // Headless bootstrap: `defaults write com.runestonelabs.gatekeeper-bar
        // bootstrapSecret <secret>` before first launch imports the secret into
        // an app-owned keychain item (no cross-app keychain ACL prompt) and
        // immediately removes it from defaults. After that, the keychain is
        // the only home the secret has.
        if KeychainStore.loadSecret() == nil,
           let bootstrap = UserDefaults.standard.string(forKey: "bootstrapSecret"),
           !bootstrap.isEmpty {
            KeychainStore.saveSecret(bootstrap)
            UserDefaults.standard.removeObject(forKey: "bootstrapSecret")
        }
        secret = KeychainStore.loadSecret() ?? ""
        configured = !secret.isEmpty
        NotificationManager.shared.onDecision = { [weak self] holdId, approve in
            Task { @MainActor in await self?.decide(holdId: holdId, approve: approve) }
        }
        restartPolling()
    }

    var client: GatekeeperClient? {
        guard let url = URL(string: baseURLString), !secret.isEmpty else { return nil }
        return GatekeeperClient(baseURL: url, secret: secret)
    }

    func updateSecret(_ newSecret: String) {
        KeychainStore.saveSecret(newSecret)
        secret = newSecret
        configured = !newSecret.isEmpty
        restartPolling()
    }

    var secretForEditing: String { secret }

    // MARK: - Polling

    func restartPolling() {
        pollTask?.cancel()
        contextTask?.cancel()

        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshPending()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
        contextTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshContext()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
    }

    func refreshPending() async {
        guard let client else { serverUp = false; return }
        do {
            let holds = try await client.pending()
            serverUp = true
            lastError = nil
            diffAndNotify(old: pending, new: holds)
            pending = holds
        } catch {
            serverUp = await client.health()
            lastError = error.localizedDescription
        }
    }

    func refreshContext() async {
        guard let client else { return }
        var stats = TodayStats()
        if let usage = try? await client.todayUsage() {
            stats.calls = usage.totalCalls
            for row in usage.rows {
                stats.denies += row.decisions["deny"] ?? 0
                stats.spendUsd += row.totalCostUsd ?? 0
            }
        }
        if let budget = try? await client.budget() {
            stats.budgetExceeded = budget.statuses.contains { $0.status.exceeded }
            stats.budgetRemainingUsd = budget.statuses.map(\.status.remainingUsd).min()
        }
        today = stats
    }

    private func diffAndNotify(old: [PendingHold], new: [PendingHold]) {
        let newIds = Set(new.map(\.id))

        for hold in new where !notifiedIds.contains(hold.id) {
            notifiedIds.insert(hold.id)
            NotificationManager.shared.notifyHold(hold)
        }

        // A hold that vanished without a local decision either expired or was
        // decided elsewhere. Only past-due holds get the expiry alarm.
        for hold in old where !newIds.contains(hold.id) {
            NotificationManager.shared.clearHoldNotification(hold.id)
            if !locallyDecidedIds.contains(hold.id) && hold.isOverdue {
                NotificationManager.shared.notifyExpired(hold)
            }
            locallyDecidedIds.remove(hold.id)
            notifiedIds.remove(hold.id)
        }
    }

    // MARK: - Decisions

    func decide(holdId: String, approve: Bool) async {
        guard let client else { return }
        do {
            locallyDecidedIds.insert(holdId)
            try await client.decide(holdId, approve: approve)
            NotificationManager.shared.clearHoldNotification(holdId)
            pending.removeAll { $0.id == holdId }
            lastError = nil
        } catch {
            locallyDecidedIds.remove(holdId)
            lastError = "Decision failed: \(error.localizedDescription)"
        }
        await refreshPending()
    }
}
