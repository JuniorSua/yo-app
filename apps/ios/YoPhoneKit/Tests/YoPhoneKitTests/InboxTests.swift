import CryptoKit
import Foundation
import Testing
@testable import YoPhoneKit

/// Mirrors phone/test/inbox.test.js.
@Suite struct InboxTests {
    let keys = try! PhoneKeys(secret: Base64URL.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }))
    let signer = Curve25519.Signing.PrivateKey()
    let forger = Curve25519.Signing.PrivateKey()
    var verifier: ReplyVerifier { ReplyVerifier(signPub: Base64URL.encode(signer.publicKey.rawRepresentation))! }

    /// An out item as the relay stores it, signed by the core's key unless `by` says otherwise.
    private func item(_ seq: Int, _ json: String, by key: Curve25519.Signing.PrivateKey? = nil, unsigned: Bool = false)
        -> OutItem {
        let box = try! keys.seal(Data(json.utf8), .out)
        let sig = try! (key ?? signer).signature(for: ReplyVerifier.message(for: box))
        return OutItem(seq: seq, box: box, sig: unsigned ? nil : Base64URL.encode(sig))
    }

    private func reply(_ seq: Int, _ text: String, n: String? = nil, by key: Curve25519.Signing.PrivateKey? = nil,
                       unsigned: Bool = false) -> OutItem {
        let counter = n.map { "\"n\":\($0)," } ?? ""
        return item(seq, #"{"v":1,\#(counter)"t":"reply","text":"\#(text)"}"#, by: key, unsigned: unsigned)
    }

    private func accept(_ items: [OutItem], cursor: Int = 0, lastN: Int64? = nil) -> Inbox.Result {
        Inbox.accept(items, cursor: cursor, lastN: lastN, verifier: verifier, keys: keys)
    }

    private func texts(_ result: Inbox.Result) -> [String] {
        result.messages.compactMap { if case let .reply(_, text, _, _) = $0 { text } else { nil } }
    }

    @Test func acceptsSignedItemsInOrderWithARisingCounter() {
        let res = accept([reply(2, "b", n: "11"), reply(1, "a", n: "10")])
        #expect(texts(res) == ["a", "b"])
        #expect(res.cursor == 2 && res.lastN == 11 && res.dropped.isEmpty && res.maxSeq == 2)
    }

    @Test func neverMovesTheCursorPastABadSignature() {
        let res = accept([reply(1, "real", n: "10"), reply(8, "unsigned", n: "49", unsigned: true),
                          reply(9, "forged", n: "50", by: forger)])
        #expect(texts(res) == ["real"])
        #expect(res.cursor == 1 && res.lastN == 10 && res.maxSeq == 9)
        #expect(res.dropped == [Inbox.Dropped(seq: 8, why: .signature), Inbox.Dropped(seq: 9, why: .signature)])
    }

    @Test func aForgedHugeSeqCannotSkipTheRealReplies() {
        let forged = reply(1_000_000, "forged", n: "99", by: forger)
        let first = accept([forged], cursor: 4, lastN: 10)
        #expect(first.cursor == 4 && first.lastN == 10 && first.messages.isEmpty)
        let next = accept([reply(5, "real", n: "11"), forged], cursor: first.cursor, lastN: 10)
        #expect(texts(next) == ["real"])
        #expect(next.cursor == 5)
    }

    @Test func dropsReplayedOrReorderedItems() {
        let old = reply(1, "old", n: "10")
        let seen = accept([old])
        let replay = accept([OutItem(seq: 7, box: old.box, sig: old.sig)], cursor: seen.cursor, lastN: seen.lastN)
        #expect(replay.messages.isEmpty && replay.cursor == 1 && replay.lastN == 10)
        #expect(replay.dropped == [Inbox.Dropped(seq: 7, why: .replay)])
        let swapped = accept([reply(2, "second", n: "12"), reply(3, "first", n: "11")], cursor: 1, lastN: 10)
        #expect(texts(swapped) == ["second"])
        #expect(swapped.cursor == 2 && swapped.lastN == 12 && swapped.dropped == [Inbox.Dropped(seq: 3, why: .replay)])
    }

    @Test func acceptsAnOlderCoreUntilACounterArrives() {
        let legacy = accept([reply(1, "old core")])
        #expect(legacy.cursor == 1 && legacy.lastN == nil && texts(legacy) == ["old core"])
        let upgraded = accept([reply(2, "new core", n: "10"), reply(3, "no n")], cursor: 1)
        #expect(texts(upgraded) == ["new core"])
        #expect(upgraded.cursor == 2 && upgraded.lastN == 10 && upgraded.dropped == [Inbox.Dropped(seq: 3, why: .replay)])
        for bad in [#""11""#, "11.5", "true", "null"] {
            let res = accept([reply(4, "x", n: bad)], cursor: 2, lastN: 10)
            #expect(res.cursor == 2 && res.dropped == [Inbox.Dropped(seq: 4, why: .replay)], "n = \(bad)")
        }
    }

    @Test func skipsItemsAtOrBelowTheCursor() {
        let res = accept([reply(3, "seen", n: "10")], cursor: 3)
        #expect(res.messages.isEmpty && res.cursor == 3 && res.maxSeq == 3 && res.dropped.isEmpty)
    }

    @Test func turnedOffMeans401Or404Revoked() {
        #expect(RelayError.unauthorized.isTurnedOff)
        #expect(RelayError.revoked.isTurnedOff)
        for error in [RelayError.http(status: 404, message: "Not found"), .rateLimited(retryAfter: 1),
                      .http(status: 503, message: "This relay isn't set up yet"), .offline] {
            #expect(!error.isTurnedOff)
        }
    }
}
