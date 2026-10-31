import Foundation

/// One entry in the conversation: the owner's message, Yo's reply, a request card, or an error note.
public struct ChatItem: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case mine, yo, card, error
    }

    /// Where the owner's message is: Sent means the relay has it, Delivered means Yo has it.
    public enum Delivery: String, Codable, Sendable {
        case sending, sent, delivered, failed

        public var label: String {
            switch self {
            case .sending: "Sending…"
            case .sent: "Sent"
            case .delivered: "Delivered"
            case .failed: "Not sent"
            }
        }
    }

    /// The message id for `mine` and `yo`, the request id for cards, a random id for errors.
    public let id: String
    public let kind: Kind
    public var at: Date
    public var text: String
    public var agent: String?
    public var delivery: Delivery?
    /// Why a message didn't send, in the PWA's words.
    public var failure: String?
    public var card: RequestCard?
    /// Set once a card is answered, here or elsewhere.
    public var outcome: String?
    /// The decision or option being sent for a card, while it's on its way.
    public var pending: String?

    /// Unique across kinds, for lists.
    public var key: String { "\(kind.rawValue):\(id)" }

    public static func mine(id: String, text: String, at: Date, delivery: Delivery = .sending) -> ChatItem {
        ChatItem(id: id, kind: .mine, at: at, text: text, delivery: delivery)
    }

    public static func yo(id: String, text: String, at: Date, agent: String? = nil) -> ChatItem {
        ChatItem(id: id, kind: .yo, at: at, text: text, agent: agent)
    }

    public static func card(_ card: RequestCard, at: Date, outcome: String? = nil) -> ChatItem {
        ChatItem(id: card.requestId, kind: .card, at: at, text: card.title, agent: card.agent, card: card,
                 outcome: outcome)
    }

    public static func error(id: String, text: String, at: Date) -> ChatItem {
        ChatItem(id: id, kind: .error, at: at, text: text)
    }

    init(id: String, kind: Kind, at: Date, text: String, agent: String? = nil, delivery: Delivery? = nil,
         card: RequestCard? = nil, outcome: String? = nil) {
        self.id = id
        self.kind = kind
        self.at = at
        self.text = text
        self.agent = agent
        self.delivery = delivery
        self.card = card
        self.outcome = outcome
    }
}
