import Foundation
import Testing
@testable import YoPhoneKit

/// Counts saves, to check what gets written and when.
@MainActor
final class CountingStore: SessionStore {
    private(set) var snapshot: SessionSnapshot?
    private(set) var saves = 0

    func load() -> SessionSnapshot? { snapshot }
    func save(_ snapshot: SessionSnapshot) {
        saves += 1
        self.snapshot = snapshot
    }
    func clear() { snapshot = nil }
}

@Suite struct RetryAfterTests {
    @Test func acceptsOnlyFiniteSecondsClampedToFiveMinutes() {
        #expect(RelayError.retryAfter("12") == 12)
        #expect(RelayError.retryAfter(" 1.5 ") == 1.5)
        #expect(RelayError.retryAfter("-5") == 0)
        #expect(RelayError.retryAfter("1e30") == 300)
        for bad in ["inf", "nan", "Infinity", "Wed, 21 Oct 2026 07:28:00 GMT", "", nil] as [String?] {
            #expect(RelayError.retryAfter(bad) == nil, "\(String(describing: bad))")
        }
    }

    @Test func aHugeRetryAfterFromTheRelayIsClamped() async throws {
        let http = FakeHTTP { _ in (429, ["Retry-After": "1e30"], #"{"error":"Too many requests"}"#) }
        let client = HTTPRelayClient(link: PhoneLink(secret: Vector.shared.secret, admit: Vector.shared.admit,
                                                     signPub: Vector.shared.signPub),
                                     keys: try PhoneKeys(secret: Vector.shared.secret), fetch: http.fetch)
        await #expect(throws: RelayError.rateLimited(retryAfter: 300)) { try await client.getOut(after: 0) }
    }

    @MainActor
    @Test func theSessionSurvivesAnyRetryAfter() async throws {
        let core = FakeCore()
        let session = try PhoneSession(link: core.link, transport: core, store: MemorySessionStore())
        for value in [TimeInterval.infinity, .nan, 1e30, -1] {
            await core.set(getError: .rateLimited(retryAfter: value))
            await session.pollOnce()
            #expect(session.issue == .busy)
        }
    }
}

@MainActor
@Suite struct SessionStorageTests {
    @Test func aClosedSessionNeverWritesAgain() async throws {
        let core = FakeCore()
        let store = CountingStore()
        let session = try PhoneSession(link: core.link, transport: core, store: store)
        await session.send("one")
        let saves = store.saves
        session.close()
        store.clear()
        await session.send("two")
        await core.emit(.reply(id: "r", text: "late", at: nil, agent: "Yo"))
        await session.pollOnce()
        #expect(store.saves == saves)
        #expect(store.snapshot == nil)
    }

    @Test func aRevokedSendDoesNotWriteTheOldConversationBack() async throws {
        let core = FakeCore()
        let store = CountingStore()
        let session = try PhoneSession(link: core.link, transport: core, store: store)
        await session.send("before")
        // Like the app: on .revoked it clears the store, then the send that hit link_revoked finishes.
        session.onEvent = { if $0 == .revoked { store.clear() } }
        await core.set(postError: .revoked)
        await session.send("after")
        #expect(session.isRevoked)
        #expect(store.snapshot == nil)
    }

    @Test func pollingWithNothingNewDoesNotRewriteHistory() async throws {
        let core = FakeCore()
        let store = CountingStore()
        let session = try PhoneSession(link: core.link, transport: core, store: store)
        await core.set(seen: 1_767_225_600_000)
        await session.pollOnce()
        let saves = store.saves
        for _ in 0..<5 { await session.pollOnce() }
        #expect(store.saves == saves)
        await core.emit(.reply(id: "r", text: "new", at: nil, agent: "Yo"))
        await session.pollOnce()
        #expect(store.saves == saves + 1)
    }
}

@Suite struct HardeningTests {
    @Test func redirectsAreRefused() async {
        let delegate = RefuseRedirects()
        let url = URL(string: "https://yo-phone.vercel.app/api/relay/out")!
        let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil,
                                       headerFields: ["Location": "https://elsewhere.example"])!
        let task = URLSession.shared.dataTask(with: url)
        let next = await delegate.urlSession(.shared, task: task, willPerformHTTPRedirection: response,
                                             newRequest: URLRequest(url: URL(string: "https://elsewhere.example")!))
        #expect(next == nil)
    }

    @Test func savedLinksAreCheckedAgainForThisBuild() {
        let params = (secret: Vector.shared.secret, admit: Vector.shared.admit, signPub: Vector.shared.signPub)
        let local = PhoneLink(secret: params.secret, admit: params.admit, signPub: params.signPub,
                              relay: URL(string: "http://localhost:5199")!)
        #expect(local.usesAllowedRelay(allowInsecureLocalhost: true))
        #expect(!local.usesAllowedRelay(allowInsecureLocalhost: false))
        let remote = PhoneLink(secret: params.secret, admit: params.admit, signPub: params.signPub,
                               relay: URL(string: "http://relay.example.com")!)
        #expect(!remote.usesAllowedRelay(allowInsecureLocalhost: true))
        let secure = PhoneLink(secret: params.secret, admit: params.admit, signPub: params.signPub)
        #expect(secure.usesAllowedRelay(allowInsecureLocalhost: false))
    }
}
