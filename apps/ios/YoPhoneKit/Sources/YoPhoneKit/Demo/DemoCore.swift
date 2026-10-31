import CryptoKit
import Foundation

/// A pretend Yo that lives on the phone, for the demo and App Review. It speaks the real protocol: it opens the
/// phone's sealed envelopes, and seals and signs its answers with its own key, so the demo runs through exactly
/// the same session code as a real Yo. Nothing touches the network.
public actor DemoCore: RelayTransport {
    public nonisolated let link: PhoneLink
    private let keys: PhoneKeys
    private let signer: Curve25519.Signing.PrivateKey
    private let step: Duration
    private let now: @Sendable () -> Date
    private var outbox: [OutItem]
    private var openCards: [String: Script.Card]
    private var turn: Task<Void, Never>?
    /// The counter on every message, like the real core's: it only goes up.
    private var lastN: Int64

    public static let agentName = "Yo"

    /// - Parameters:
    ///   - step: the pause between Yo's steps (working → reply). Tests pass `.zero`.
    ///   - opening: messages waiting in the mailbox when the demo starts (screenshot scenes).
    ///   - openCards: cards from `opening` or earlier history that can still be answered.
    ///   - relay: the relay the link names. Nothing is sent there; screenshots show its host.
    public init(step: Duration = .milliseconds(1100), opening: [OutMessage] = [], openCards: [RequestCard] = [],
                relay: URL = URL(string: "https://demo.yo.invalid")!, now: @escaping @Sendable () -> Date = Date.init) {
        let secret = Base64URL.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
        let signer = Curve25519.Signing.PrivateKey()
        let link = PhoneLink(
            secret: secret,
            admit: Base64URL.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }),
            signPub: Base64URL.encode(signer.publicKey.rawRepresentation),
            relay: relay
        )
        let keys = try! PhoneKeys(secret: secret)
        self.link = link
        self.keys = keys
        self.signer = signer
        self.step = step
        self.now = now
        lastN = Int64(opening.count)
        outbox = opening.enumerated().map { i, message in
            Self.seal(message, seq: i + 1, n: Int64(i + 1), keys: keys, signer: signer)
        }
        self.openCards = Dictionary(uniqueKeysWithValues: openCards.compactMap { card in
            Script.card(for: card.requestId).map { (card.requestId, $0) }
        })
    }

    // MARK: - RelayTransport

    public func postIn(_ envelope: String) async throws(RelayError) {
        guard let data = try? keys.open(envelope, .in),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["t"] as? String
        else { throw .http(status: 400, message: "box must be an envelope") }
        switch t {
        case "hello":
            emit(.hello(agentName: Self.agentName))
            for card in openCards.values { emit(.request(card.request)) }
        case "msg":
            guard let id = obj["id"] as? String, let text = obj["text"] as? String else { return }
            emit(.ack(ids: [id]))
            run(Script.reply(to: text))
        case "respond":
            guard let requestId = obj["requestId"] as? String, let card = openCards.removeValue(forKey: requestId)
            else { return }
            let answer = obj["answer"] as? String
            let approved = obj["decision"] as? String == "approve"
            emit(.resolved(requestId: requestId,
                           outcome: answer.map { "Picked “\($0)”" } ?? (approved ? "Approved" : "Denied")))
            run(card.followUp(approved: approved, answer: answer))
        case "stop":
            turn?.cancel()
            turn = nil
            emit(.status(state: .idle, detail: "", agent: Self.agentName))
            emit(.reply(id: randomMessageID(), text: "Okay, I stopped.", at: now(), agent: Self.agentName))
        default:
            break
        }
    }

    public func getOut(after seq: Int) async throws(RelayError) -> OutPage {
        OutPage(items: outbox.filter { $0.seq > seq }, seen: Double(now().millis))
    }

    // MARK: - Turns

    private func run(_ turn: Script.Turn) {
        self.turn?.cancel()
        self.turn = Task { [step] in
            emit(.status(state: .working, detail: turn.steps.first ?? "Thinking", agent: Self.agentName))
            for detail in turn.steps.dropFirst() {
                try? await Task.sleep(for: step)
                guard !Task.isCancelled else { return }
                emit(.status(state: .working, detail: detail, agent: Self.agentName))
            }
            try? await Task.sleep(for: step * 1.5)
            guard !Task.isCancelled else { return }
            emit(.reply(id: randomMessageID(), text: turn.reply, at: now(), agent: Self.agentName))
            if let card = turn.card {
                openCards[card.request.requestId] = card
                emit(.request(card.request))
            }
            emit(.status(state: .idle, detail: "", agent: Self.agentName))
        }
    }

    private func emit(_ message: OutMessage) {
        lastN += 1
        outbox.append(Self.seal(message, seq: (outbox.last?.seq ?? 0) + 1, n: lastN, keys: keys, signer: signer))
    }

    private static func seal(_ message: OutMessage, seq: Int, n: Int64, keys: PhoneKeys,
                             signer: Curve25519.Signing.PrivateKey) -> OutItem {
        let box = try! keys.seal(message.json(n: n).data, .out)
        let sig = try! signer.signature(for: ReplyVerifier.message(for: box))
        return OutItem(seq: seq, box: box, sig: Base64URL.encode(sig))
    }
}
