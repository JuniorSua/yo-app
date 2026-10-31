import CryptoKit
import Foundation
@testable import YoPhoneKit

/// A scriptable relay + core for session tests: it decrypts what the phone posts and serves signed `out` items.
actor FakeCore: RelayTransport {
    nonisolated let link: PhoneLink
    private let keys: PhoneKeys
    private let signer = Curve25519.Signing.PrivateKey()
    /// The JSON of every message the phone posted, in order.
    private(set) var received: [String] = []
    private(set) var outbox: [OutItem] = []
    private(set) var getOutCalls: [Int] = []
    var postError: RelayError?
    var getError: RelayError?
    var seen: Double?
    /// When set, `getOut` returns at most this many items and sets `more`.
    var pageSize: Int?
    var reset = false
    /// The counter the next message carries, like the real core's.
    private var nextN: Int64 = 1_000

    init(secret: String = Vector.shared.secret) {
        link = PhoneLink(secret: secret, admit: Vector.shared.admit,
                         signPub: Base64URL.encode(signer.publicKey.rawRepresentation))
        keys = try! PhoneKeys(secret: secret)
    }

    func postIn(_ envelope: String) async throws(RelayError) {
        if let postError { throw postError }
        let data = try! keys.open(envelope, .in)
        received.append(String(decoding: data, as: UTF8.self))
    }

    func getOut(after seq: Int) async throws(RelayError) -> OutPage {
        getOutCalls.append(seq)
        if let getError { throw getError }
        if reset { return OutPage(items: outbox, seen: seen, reset: true) }
        var items = outbox.filter { $0.seq > seq }
        var more = false
        if let pageSize, items.count > pageSize {
            items = Array(items.prefix(pageSize))
            more = true
        }
        return OutPage(items: items, seen: seen, more: more)
    }

    /// Queues a correctly sealed and signed message with the next counter.
    @discardableResult
    func emit(_ message: OutMessage) -> Int {
        nextN += 1
        return emit(message, n: nextN)
    }

    /// Queues a signed message with a chosen counter (nil: none, like a core from before the counter).
    @discardableResult
    func emit(_ message: OutMessage, n: Int64?) -> Int {
        let box = try! keys.seal(message.json(n: n).data, .out)
        let sig = try! signer.signature(for: ReplyVerifier.message(for: box))
        return push(box: box, sig: Base64URL.encode(sig))
    }

    /// Queues a signed message built from raw fields (for kinds `OutMessage` doesn't model, like `images`), with
    /// `v: 1` and the next counter added.
    @discardableResult
    func emit(fields: [String: Any]) -> Int {
        nextN += 1
        var obj = fields
        obj["v"] = 1
        obj["n"] = nextN
        let box = try! keys.seal(try! JSONSerialization.data(withJSONObject: obj), .out)
        let sig = try! signer.signature(for: ReplyVerifier.message(for: box))
        return push(box: box, sig: Base64URL.encode(sig))
    }

    /// Queues an item with whatever signature the test wants.
    @discardableResult
    func push(box: String, sig: String?) -> Int {
        let seq = (outbox.last?.seq ?? 0) + 1
        outbox.append(OutItem(seq: seq, box: box, sig: sig))
        return seq
    }

    func seal(_ message: OutMessage, n: Int64? = nil) -> String {
        try! keys.seal(message.json(n: n).data, .out)
    }

    func set(postError: RelayError?) { self.postError = postError }
    func set(getError: RelayError?) { self.getError = getError }
    func set(seen: Double?) { self.seen = seen }
    func set(pageSize: Int?) { self.pageSize = pageSize }
    func set(reset: Bool) { self.reset = reset }
    func clearOutbox() { outbox = [] }
}

/// A posted message's JSON as a dictionary.
func fields(_ json: String) -> [String: String] {
    let obj = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    return obj.mapValues { "\($0)" }
}

/// A clock tests can move.
@MainActor
final class TestClock {
    var now = Date(millis: 1_767_225_600_000)
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}
