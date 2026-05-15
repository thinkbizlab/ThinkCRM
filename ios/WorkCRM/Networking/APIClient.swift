import Foundation

public enum APIError: Error, LocalizedError {
    case notAuthenticated
    case http(status: Int, body: String?)
    case decoding(Error)
    case transport(Error)

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated:           return "Not signed in."
        case .http(let s, let b):         return "HTTP \(s): \(b ?? "")"
        case .decoding(let e):            return "Decoding failed: \(e)"
        case .transport(let e):           return "Network error: \(e.localizedDescription)"
        }
    }
}

/// Thin wrapper around URLSession with:
///   - Bearer-token injection on every request,
///   - single-flight refresh on 401 (so 12 parallel requests don't fire 12
///     refreshes),
///   - JSON encoding/decoding with ISO-8601 dates,
///   - escape hatch for endpoints that return non-paginated bare arrays.
public actor APIClient {
    public static let shared = APIClient()

    private let session: URLSession
    private let baseURL: URL
    private var refreshTask: Task<Void, Error>?

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        // The backend returns ISO-8601 with optional fractional seconds.
        // `iso8601withFractionalSeconds` isn't a thing — we use a custom
        // strategy that handles both shapes.
        let isoMs: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f
        }()
        let iso: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime]
            return f
        }()
        d.dateDecodingStrategy = .custom { dec in
            let container = try dec.singleValueContainer()
            let s = try container.decode(String.self)
            if let date = isoMs.date(from: s) ?? iso.date(from: s) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(s)"
            )
        }
        return d
    }()

    public init(baseURL: URL = AppConfig.apiBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Public verbs

    public func get<Response: Decodable>(_ path: String, query: [URLQueryItem] = [], as: Response.Type = Response.self) async throws -> Response {
        try await perform(method: "GET", path: path, query: query, body: Optional<EmptyBody>.none, decode: Response.self)
    }

    public func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body, as: Response.Type = Response.self) async throws -> Response {
        try await perform(method: "POST", path: path, query: [], body: body, decode: Response.self)
    }

    public func postExpectingEmpty<Body: Encodable>(_ path: String, body: Body) async throws {
        let _: EmptyBody = try await perform(method: "POST", path: path, query: [], body: body, decode: EmptyBody.self, allowEmptyBody: true)
    }

    public func patch<Body: Encodable, Response: Decodable>(_ path: String, body: Body, as: Response.Type = Response.self) async throws -> Response {
        try await perform(method: "PATCH", path: path, query: [], body: body, decode: Response.self)
    }

    public func delete(_ path: String) async throws {
        let _: EmptyBody = try await perform(method: "DELETE", path: path, query: [], body: Optional<EmptyBody>.none, decode: EmptyBody.self, allowEmptyBody: true)
    }

    // MARK: - Core

    private func perform<Body: Encodable, Response: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?,
        decode: Response.Type,
        allowEmptyBody: Bool = false,
        attempt: Int = 0
    ) async throws -> Response {
        let req = try buildRequest(method: method, path: path, query: query, body: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(status: -1, body: nil)
        }

        if http.statusCode == 401, attempt == 0, TokenStore.shared.load() != nil {
            // Single-flight refresh: if another caller already kicked off a
            // refresh, await theirs instead of starting a competing one.
            try await refreshIfNeeded()
            return try await perform(method: method, path: path, query: query, body: body, decode: decode, allowEmptyBody: allowEmptyBody, attempt: 1)
        }

        guard (200...299).contains(http.statusCode) else {
            let bodyText = String(data: data, encoding: .utf8)
            throw APIError.http(status: http.statusCode, body: bodyText)
        }

        if allowEmptyBody, data.isEmpty {
            // Caller asked for Empty; synthesise it rather than asking the
            // decoder to parse "".
            return EmptyBody() as! Response
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    private func buildRequest<Body: Encodable>(method: String, path: String, query: [URLQueryItem], body: Body?) throws -> URLRequest {
        let trimmed = String(path.trimmingPrefix("/"))
        var components = URLComponents(url: baseURL.appendingPathComponent(trimmed), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = (components.queryItems ?? []) + query
        }
        var req = URLRequest(url: components.url!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "accept")

        if let token = TokenStore.shared.load()?.accessToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }

        if let body, !(body is EmptyBody) {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try encoder.encode(body)
        }
        return req
    }

    // MARK: - Refresh

    private func refreshIfNeeded() async throws {
        if let existing = refreshTask {
            // Already in flight — piggy-back.
            return try await existing.value
        }
        let task: Task<Void, Error> = Task { [weak self] in
            guard let self else { return }
            try await self.runRefresh()
        }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }

    private func runRefresh() async throws {
        guard let session = TokenStore.shared.load() else {
            throw APIError.notAuthenticated
        }
        let request = RefreshRequest(refreshToken: session.refreshToken)
        let url = baseURL.appendingPathComponent("auth/refresh")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("application/json", forHTTPHeaderField: "accept")
        req.httpBody = try encoder.encode(request)

        let (data, response) = try await self.session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            // Refresh failed → clear the session so RootView pops back to Login.
            TokenStore.shared.clear()
            throw APIError.notAuthenticated
        }
        let refreshed = try decoder.decode(RefreshResponse.self, from: data)
        TokenStore.shared.save(AuthSession(
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            user: session.user
        ))
    }
}

/// Marker for the no-body slot on GET requests and the no-response slot on
/// fire-and-forget endpoints like `DELETE`. Distinct from `Never` so we can
/// conform to both Encodable and Decodable.
public struct EmptyBody: Codable, Sendable {}
