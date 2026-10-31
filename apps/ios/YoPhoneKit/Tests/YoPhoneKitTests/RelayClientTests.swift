import Foundation
import Testing
@testable import YoPhoneKit

/// Records requests and answers each with a canned response.
final class FakeHTTP: @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private let respond: @Sendable (URLRequest) throws -> (Int, [String: String], String)

    init(_ respond: @escaping @Sendable (URLRequest) throws -> (Int, [String: String], String)) {
        self.respond = respond
    }

    var requests: [URLRequest] { lock.withLock { _requests } }

    var fetch: HTTPRelayClient.Fetch {
        { [self] request in
            lock.withLock { _requests.append(request) }
            let (status, headers, body) = try respond(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: headers)!
            return (Data(body.utf8), response)
        }
    }
}

@Suite struct RelayClientTests {
    let link = PhoneLink(secret: Vector.shared.secret, admit: Vector.shared.admit, signPub: Vector.shared.signPub,
                         relay: URL(string: "http://localhost:5199")!)
    let keys = try! PhoneKeys(secret: Vector.shared.secret)

    private func client(_ http: FakeHTTP) -> HTTPRelayClient {
        HTTPRelayClient(link: link, keys: keys, fetch: http.fetch)
    }

    @Test func postsAnEnvelopeWithTheBearerTokenAndAdmit() async throws {
        let http = FakeHTTP { _ in (200, [:], #"{"ok":true}"#) }
        try await client(http).postIn("ENVELOPE")
        let request = try #require(http.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "http://localhost:5199/api/relay/in")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Vector.shared.authToken)")
        #expect(request.value(forHTTPHeaderField: "X-Yo-Admit") == Vector.shared.admit)
        #expect(request.value(forHTTPHeaderField: "X-Yo-Core") == nil)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"box":"ENVELOPE"}"#)
    }

    @Test func readsAPageOfOutItems() async throws {
        let http = FakeHTTP { _ in
            (200, [:], #"{"items":[{"seq":7,"box":"B7","sig":"S7"},{"seq":8,"box":"B8","sig":null}],"seen":1767225600000,"more":true}"#)
        }
        let page = try await client(http).getOut(after: 6)
        #expect(http.requests.first?.httpMethod == "GET")
        #expect(http.requests.first?.url?.absoluteString == "http://localhost:5199/api/relay/out?after=6")
        #expect(page == OutPage(items: [OutItem(seq: 7, box: "B7", sig: "S7"), OutItem(seq: 8, box: "B8", sig: nil)],
                                seen: 1_767_225_600_000, more: true))
        let reset = try await client(FakeHTTP { _ in (200, [:], #"{"items":[],"seen":null,"reset":true}"#) })
            .getOut(after: 99)
        #expect(reset == OutPage(items: [], seen: nil, reset: true))
    }

    @Test(arguments: [
        (404, [:], #"{"error":"link_revoked"}"#, RelayError.revoked),
        (404, [:], #"{"error":"Not found"}"#, RelayError.http(status: 404, message: "Not found")),
        (401, [:], #"{"error":"Unauthorized"}"#, RelayError.unauthorized),
        (413, [:], #"{"error":"Too large"}"#, RelayError.tooLarge),
        (429, ["Retry-After": "12"], #"{"error":"Too many requests"}"#, RelayError.rateLimited(retryAfter: 12)),
        (429, [:], #"{"error":"Too many messages waiting"}"#, RelayError.rateLimited(retryAfter: nil)),
        (502, [:], "oops", RelayError.http(status: 502, message: "Error 502")),
    ] as [(Int, [String: String], String, RelayError)])
    func mapsRelayErrors(status: Int, headers: [String: String], body: String, expected: RelayError) async {
        let http = FakeHTTP { _ in (status, headers, body) }
        await #expect(throws: expected) { try await client(http).postIn("E") }
        await #expect(throws: expected) { try await client(http).getOut(after: 0) }
    }

    @Test func networkFailuresAreOffline() async {
        let http = FakeHTTP { _ in throw URLError(.notConnectedToInternet) }
        await #expect(throws: RelayError.offline) { try await client(http).getOut(after: 0) }
    }

    @Test func sendFailureTextMatchesThePWA() {
        #expect(RelayError.rateLimited(retryAfter: nil).sendFailureText == "Yo has a lot waiting. Try again in a minute.")
        #expect(RelayError.tooLarge.sendFailureText == "That message is too long.")
        #expect(RelayError.offline.sendFailureText == "No connection.")
        #expect(RelayError.unauthorized.sendFailureText == "Couldn't send.")
    }
}
