import Foundation

/// One open hold, as returned by GET /approvals/pending.
struct PendingHold: Codable, Identifiable, Equatable {
    struct Actor: Codable, Equatable {
        let type: String
        let name: String
        let role: String?
    }

    let id: String
    let toolName: String
    let actor: Actor
    let argsSummary: String
    let requestId: String
    let createdAt: String
    let expiresAt: String
    let external: Bool

    var expiresAtDate: Date { Self.iso.date(from: expiresAt) ?? .distantPast }
    var createdAtDate: Date { Self.iso.date(from: createdAt) ?? .distantPast }
    var isOverdue: Bool { expiresAtDate < Date() }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

struct PendingResponse: Codable {
    let pending: [PendingHold]
    let count: Int
}

/// Subset of the /usage response we surface in the Today panel.
struct UsageRow: Codable {
    let day: String
    let callCount: Int
    let decisions: [String: Int]
    let totalCostUsd: Double?
}

struct UsageSummary: Codable {
    let rows: [UsageRow]
    let totalCalls: Int
}

/// Subset of the /budget response.
struct BudgetStatusEntry: Codable {
    struct Status: Codable {
        let currentUsd: Double
        let remainingUsd: Double
        let currentCalls: Int
        let exceeded: Bool
    }
    struct Rule: Codable {
        let name: String?
    }
    let rule: Rule
    let status: Status
}

struct BudgetResponse: Codable {
    let statuses: [BudgetStatusEntry]
}

/// Aggregated "context" numbers shown at the top of the menu.
struct TodayStats: Equatable {
    var calls: Int = 0
    var denies: Int = 0
    var spendUsd: Double = 0
    var budgetExceeded: Bool = false
    var budgetRemainingUsd: Double? = nil
}
