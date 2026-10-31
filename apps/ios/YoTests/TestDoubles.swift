import Foundation
@testable import Yo
import YoPhoneKit

/// A link vault in memory.
final class MemoryVault: LinkVault, @unchecked Sendable {
    private let lock = NSLock()
    private var link: PhoneLink?

    func load() -> PhoneLink? { lock.withLock { link } }
    func save(_ link: PhoneLink) throws { lock.withLock { self.link = link } }
    func clear() { lock.withLock { link = nil } }
}

/// A relay that records what the phone posts (still sealed) and answers polls with nothing, or an error.
actor StubRelay: RelayTransport {
    private(set) var posted: [String] = []
    private(set) var polls = 0
    var failure: RelayError?

    func postIn(_ envelope: String) async throws(RelayError) {
        if let failure { throw failure }
        posted.append(envelope)
    }

    func getOut(after seq: Int) async throws(RelayError) -> OutPage {
        polls += 1
        if let failure { throw failure }
        return OutPage(items: [], seen: Date().timeIntervalSince1970 * 1000)
    }

    func fail(with error: RelayError?) { failure = error }
}

/// Speech that the test drives by hand.
@MainActor
final class FakeListener: SpeechListening {
    private(set) var started = 0
    private(set) var stopped = 0
    private var onText: ((String) -> Void)?
    private var onEnd: ((ListenEnd) -> Void)?

    func start(onText: @escaping (String) -> Void, onEnd: @escaping (ListenEnd) -> Void) {
        started += 1
        self.onText = onText
        self.onEnd = onEnd
    }

    func stop() {
        stopped += 1
        onEnd?(.finished)
    }

    func cancel() {
        onText = nil
        onEnd = nil
    }

    func hear(_ text: String) { onText?(text) }
    func end(_ end: ListenEnd) { onEnd?(end) }
}

enum Links {
    static let signPub = "JUO5L_EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0"
    static let admit = "jY3o3uB5gcBP6Sd7hq000fnWtIMv7910wsgDIxFjC2s"

    static func make(secretByte: UInt8, host: String = "https://yo-phone.vercel.app") -> String {
        let secret = Base64URL.encode(Data(repeating: secretByte, count: 32))
        return "\(host)/#k=\(secret)&a=\(admit)&p=\(signPub)"
    }
}
