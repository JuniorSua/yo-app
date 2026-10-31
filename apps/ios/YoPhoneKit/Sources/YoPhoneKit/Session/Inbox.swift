import Foundation

/// Which `out` items the phone accepts, mirroring phone/lib/inbox.js (docs/phone/PROTOCOL.md, "Signed replies" and
/// "Counter"). Two rules keep a relay from steering the phone:
/// - The read cursor only moves past items that verified and were accepted, so a forged item with a huge `seq`
///   can't make the phone skip the real replies after it.
/// - Each message carries `n`, the core's counter, inside the signed and encrypted envelope. It must go up, so a
///   replayed or reordered item is dropped. Items without `n` (an older core) are accepted until one with `n` arrives.
public enum Inbox {
    public enum DropReason: String, Equatable, Sendable {
        case signature, replay
    }

    public struct Dropped: Equatable, Sendable {
        public let seq: Int
        public let why: DropReason
    }

    public struct Result: Equatable, Sendable {
        /// Accepted messages this app understands, in order.
        public var messages: [OutMessage]
        /// The new cursor and counter to save.
        public var cursor: Int
        public var lastN: Int64?
        /// Refused items; the cursor didn't move for them.
        public var dropped: [Dropped]
        /// The highest seq on the page, for paging.
        public var maxSeq: Int
    }

    public static func accept(_ items: [OutItem], cursor: Int, lastN: Int64?, verifier: ReplyVerifier,
                              keys: PhoneKeys) -> Result {
        var result = Result(messages: [], cursor: cursor, lastN: lastN, dropped: [], maxSeq: cursor)
        for item in items.sorted(by: { $0.seq < $1.seq }) {
            result.maxSeq = max(result.maxSeq, item.seq)
            guard item.seq > result.cursor else { continue }
            // Only the core holds the signing key, so a bad signature means the item didn't come from your Yo.
            guard verifier.verify(envelope: item.box, sig: item.sig) else {
                result.dropped.append(Dropped(seq: item.seq, why: .signature))
                continue
            }
            guard let plaintext = try? keys.open(item.box, .out),
                  let obj = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
            else {
                // Signed by the core but unreadable (shouldn't happen): skip it, but it was the core's, so move on.
                result.cursor = item.seq
                continue
            }
            if obj.keys.contains("n") || result.lastN != nil {
                guard let n = safeInteger(obj["n"]), result.lastN.map({ n > $0 }) ?? true else {
                    result.dropped.append(Dropped(seq: item.seq, why: .replay))
                    continue
                }
                result.lastN = n
            }
            if let message = OutMessage(json: plaintext) { result.messages.append(message) }
            result.cursor = item.seq
        }
        return result
    }

    /// JavaScript's `Number.isSafeInteger`.
    static func safeInteger(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let d = number.doubleValue
        guard d.isFinite, d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else { return nil }
        return Int64(d)
    }
}
