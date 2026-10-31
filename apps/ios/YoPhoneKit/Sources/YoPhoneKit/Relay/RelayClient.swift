import Foundation

/// One signed, encrypted item from `GET /api/relay/out`.
public struct OutItem: Equatable, Sendable {
    public let seq: Int
    public let box: String
    public let sig: String?

    public init(seq: Int, box: String, sig: String?) {
        self.seq = seq
        self.box = box
        self.sig = sig
    }
}

/// A page of `GET /api/relay/out?after=`.
public struct OutPage: Equatable, Sendable {
    public var items: [OutItem]
    /// When the core last polled, in ms since 1970, or nil if it hasn't in the last 10 minutes.
    public var seen: Double?
    /// More items are waiting: fetch again right away.
    public var more: Bool
    /// The mailbox expired and its counter restarted: rewind the cursor.
    public var reset: Bool

    public init(items: [OutItem], seen: Double?, more: Bool = false, reset: Bool = false) {
        self.items = items
        self.seen = seen
        self.more = more
        self.reset = reset
    }
}

public enum RelayError: Error, Equatable, Sendable {
    /// No network, or the relay couldn't be reached.
    case offline
    /// 404 `link_revoked`: the owner turned this link off or made a new one.
    case revoked
    /// 401: the relay doesn't admit this link any more (e.g. its register key changed).
    case unauthorized
    /// 413: the message is too long.
    case tooLarge
    /// 429, with the `Retry-After` seconds when the relay sent them.
    case rateLimited(retryAfter: TimeInterval?)
    case http(status: Int, message: String)

    /// The longest wait a `Retry-After` can ask for.
    public static let maxRetryAfter: TimeInterval = 300

    /// A `Retry-After` in seconds: finite numbers only, clamped to 0…300. Anything else (a date, `inf`, junk) is nil.
    public static func retryAfter(_ header: String?) -> TimeInterval? {
        guard let header, let seconds = Double(header.trimmingCharacters(in: .whitespaces)), seconds.isFinite else {
            return nil
        }
        return min(max(seconds, 0), maxRetryAfter)
    }

    /// The link no longer works and retrying can't fix it: 404 `link_revoked` or 401 (`isTurnedOff` in
    /// phone/lib/inbox.js).
    public var isTurnedOff: Bool { self == .revoked || self == .unauthorized }

    /// The PWA's wording for a message that didn't send.
    public var sendFailureText: String {
        switch self {
        case .rateLimited: "Yo has a lot waiting. Try again in a minute."
        case .tooLarge: "That message is too long."
        case .offline: "No connection."
        default: "Couldn't send."
        }
    }
}

/// The phone's two relay calls. The real one is `HTTPRelayClient`; the demo and tests use local ones.
public protocol RelayTransport: Sendable {
    /// `POST /api/relay/in` with one envelope.
    func postIn(_ envelope: String) async throws(RelayError)
    /// `GET /api/relay/out?after=<seq>`.
    func getOut(after seq: Int) async throws(RelayError) -> OutPage
}

/// Talks to a Yo Phone relay over HTTPS (docs/phone/PROTOCOL.md, "Relay HTTP API" and "v2").
public struct HTTPRelayClient: RelayTransport {
    public typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let base: URL
    private let authToken: String
    private let admit: String
    private let fetch: Fetch

    public init(link: PhoneLink, keys: PhoneKeys, fetch: Fetch? = nil) {
        base = link.relay.appending(path: "api/relay")
        authToken = keys.authToken
        admit = link.admit
        self.fetch = fetch ?? Self.urlSession
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: RefuseRedirects(), delegateQueue: nil)
    }()

    private static let urlSession: Fetch = { try await session.data(for: $0) }

    public func postIn(_ envelope: String) async throws(RelayError) {
        var request = makeRequest("in")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = JSONValue.object([("box", .string(envelope))]).data
        _ = try await send(request)
    }

    public func getOut(after seq: Int) async throws(RelayError) -> OutPage {
        var request = makeRequest("out")
        request.url = request.url?.appending(queryItems: [URLQueryItem(name: "after", value: String(max(0, seq)))])
        let obj = try await send(request)
        let items = (obj["items"] as? [[String: Any]] ?? []).compactMap { raw -> OutItem? in
            guard let seq = (raw["seq"] as? NSNumber)?.intValue, let box = raw["box"] as? String else { return nil }
            return OutItem(seq: seq, box: box, sig: raw["sig"] as? String)
        }
        return OutPage(
            items: items,
            seen: (obj["seen"] as? NSNumber)?.doubleValue,
            more: obj["more"] as? Bool ?? false,
            reset: obj["reset"] as? Bool ?? false
        )
    }

    private func makeRequest(_ path: String) -> URLRequest {
        var request = URLRequest(url: base.appending(path: path))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue(admit, forHTTPHeaderField: "X-Yo-Admit")
        return request
    }

    private func send(_ request: URLRequest) async throws(RelayError) -> [String: Any] {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await fetch(request)
        } catch {
            throw .offline
        }
        guard let http = response as? HTTPURLResponse else { throw .offline }
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard !(200..<300).contains(http.statusCode) else { return obj }
        let message = obj["error"] as? String ?? "Error \(http.statusCode)"
        switch http.statusCode {
        case 404 where message == "link_revoked":
            throw .revoked
        case 401:
            throw .unauthorized
        case 413:
            throw .tooLarge
        case 429:
            throw .rateLimited(retryAfter: RelayError.retryAfter(http.value(forHTTPHeaderField: "Retry-After")))
        default:
            throw .http(status: http.statusCode, message: message)
        }
    }
}

/// Never follows a redirect: it would carry the link's bearer token and admit header to wherever it points. The
/// 3xx response comes back as is, and the client reports it as an error.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}
