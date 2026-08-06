import Foundation

enum ClientError: LocalizedError {
    case badURL
    case http(Int, String)
    case unconfigured

    var errorDescription: String? {
        switch self {
        case .badURL: return "Invalid gatekeeper URL"
        case .http(let code, let body): return "HTTP \(code): \(body)"
        case .unconfigured: return "Set the gatekeeper URL and secret in Settings"
        }
    }
}

/// Thin async client for the gatekeeper HTTP API. Auth is the shared secret;
/// decisions go through the direct POST endpoints (no signed-URL dependency,
/// so a BASE_URL mismatch inside docker can't break the approve path).
struct GatekeeperClient {
    var baseURL: URL
    var secret: String

    private var session: URLSession { .shared }

    private func request(_ path: String, method: String = "GET") throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw ClientError.badURL }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.httpMethod = method
        req.setValue(secret, forHTTPHeaderField: "X-Gatekeeper-Secret")
        return req
    }

    private func run<T: Decodable>(_ req: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw ClientError.http(code, String(data: data.prefix(200), encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func health() async -> Bool {
        guard let req = try? request("/health") else { return false }
        guard let (_, response) = try? await session.data(for: req) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func pending() async throws -> [PendingHold] {
        try await run(try request("/approvals/pending"), as: PendingResponse.self).pending
    }

    func decide(_ id: String, approve: Bool) async throws {
        struct DecisionReply: Decodable { let success: Bool? }
        let path = "/approvals/\(id)/\(approve ? "approve" : "deny")"
        _ = try await run(try request(path, method: "POST"), as: DecisionReply.self)
    }

    /// Usage since UTC midnight — the Today panel's data.
    func todayUsage() async throws -> UsageSummary {
        let day = ISO8601DateFormatter.string(
            from: Calendar(identifier: .gregorian).startOfDay(for: Date()),
            timeZone: TimeZone(identifier: "UTC")!,
            formatOptions: [.withInternetDateTime]
        )
        return try await run(
            try request("/usage?since=\(day)"),
            as: UsageSummary.self
        )
    }

    func budget() async throws -> BudgetResponse {
        try await run(try request("/budget"), as: BudgetResponse.self)
    }
}
