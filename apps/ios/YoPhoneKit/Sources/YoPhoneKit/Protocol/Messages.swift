import Foundation

/// Phone → core messages (docs/phone/PROTOCOL.md, "Messages"). Every message carries `v: 1`.
public enum InMessage: Equatable, Sendable {
    case hello(id: String, device: String)
    case msg(id: String, text: String, at: Date)
    case respond(id: String, requestId: String, decision: Decision, answer: String?)
    case stop(id: String)

    public enum Decision: String, Sendable {
        case approve, deny
    }

    /// Keys in the same order as the PWA's `{ v: 1, ...msg }`, so the JSON matches byte for byte.
    public var json: JSONValue {
        var pairs: [(String, JSONValue)] = [("v", .int(1))]
        switch self {
        case let .hello(id, device):
            pairs += [("t", .string("hello")), ("id", .string(id)), ("device", .string(device))]
        case let .msg(id, text, at):
            pairs += [("t", .string("msg")), ("id", .string(id)), ("text", .string(text)), ("at", .int(at.millis))]
        case let .respond(id, requestId, decision, answer):
            pairs += [
                ("t", .string("respond")), ("id", .string(id)), ("requestId", .string(requestId)),
                ("decision", .string(decision.rawValue)),
            ]
            if let answer, !answer.isEmpty { pairs.append(("answer", .string(answer))) }
        case let .stop(id):
            pairs += [("t", .string("stop")), ("id", .string(id))]
        }
        return .object(pairs)
    }
}

/// Core → phone messages, read as leniently as the PWA reads them.
public enum OutMessage: Equatable, Sendable {
    case hello(agentName: String?)
    case ack(ids: [String])
    case status(state: WorkState, detail: String, agent: String?)
    case reply(id: String?, text: String, at: Date?, agent: String?)
    case request(RequestCard)
    case resolved(requestId: String, outcome: String)
    case error(text: String, agent: String?)

    public enum WorkState: String, Sendable {
        case working, queued, idle
    }

    /// Nil for anything that isn't a v1 message this app knows.
    public init?(json data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (obj["v"] as? NSNumber)?.intValue == 1, let t = obj["t"] as? String
        else { return nil }
        let agent = Self.string(obj["agent"])
        switch t {
        case "hello":
            let name = (obj["agent"] as? [String: Any]).flatMap { Self.string($0["name"]) }
            self = .hello(agentName: name.map { String($0.prefix(60)) })
        case "ack":
            self = .ack(ids: (obj["ids"] as? [Any])?.compactMap { $0 as? String } ?? [])
        case "status":
            let state = (obj["state"] as? String).flatMap(WorkState.init) ?? .idle
            self = .status(state: state, detail: String((Self.string(obj["detail"]) ?? "").prefix(120)), agent: agent)
        case "reply":
            let at = (obj["at"] as? NSNumber).map { Date(millis: $0.doubleValue) }
            self = .reply(id: Self.string(obj["id"]), text: Self.string(obj["text"]) ?? "", at: at, agent: agent)
        case "request":
            guard let requestId = Self.string(obj["requestId"]), !requestId.isEmpty else { return nil }
            let kind = (obj["kind"] as? String).flatMap(RequestCard.Kind.init) ?? .approval
            let options = (obj["options"] as? [Any])?.compactMap(Self.string).prefix(8) ?? []
            self = .request(RequestCard(
                requestId: requestId,
                kind: kind,
                title: Self.string(obj["title"]) ?? "Yo needs you",
                detail: Self.string(obj["detail"]) ?? "",
                options: Array(options),
                agent: agent
            ))
        case "resolved":
            guard let requestId = Self.string(obj["requestId"]) else { return nil }
            self = .resolved(requestId: requestId, outcome: Self.string(obj["outcome"]) ?? "Done")
        case "error":
            self = .error(text: Self.string(obj["text"]) ?? "Something went wrong", agent: agent)
        default:
            return nil
        }
    }

    /// The JSON the core sends for this message, with its counter `n` when given. The demo's pretend Yo and the
    /// tests use it.
    public func json(n: Int64? = nil) -> JSONValue {
        var pairs: [(String, JSONValue)] = [("v", .int(1))]
        if let n { pairs.append(("n", .int(n))) }
        func add(_ key: String, _ value: String?) {
            if let value { pairs.append((key, .string(value))) }
        }
        switch self {
        case let .hello(name):
            pairs += [("t", .string("hello")), ("agent", .object([("name", .string(name ?? "Yo"))]))]
        case let .ack(ids):
            pairs += [("t", .string("ack")), ("ids", .array(ids.map(JSONValue.string)))]
        case let .status(state, detail, agent):
            pairs.append(("t", .string("status")))
            add("agent", agent)
            pairs.append(("state", .string(state.rawValue)))
            if !detail.isEmpty { add("detail", detail) }
        case let .reply(id, text, at, agent):
            pairs.append(("t", .string("reply")))
            add("id", id)
            add("agent", agent)
            pairs.append(("text", .string(text)))
            if let at { pairs.append(("at", .int(at.millis))) }
        case let .request(card):
            pairs += [("t", .string("request")), ("requestId", .string(card.requestId))]
            add("agent", card.agent)
            pairs += [("kind", .string(card.kind.rawValue)), ("title", .string(card.title)),
                      ("detail", .string(card.detail))]
            if !card.options.isEmpty { pairs.append(("options", .array(card.options.map(JSONValue.string)))) }
        case let .resolved(requestId, outcome):
            pairs += [("t", .string("resolved")), ("requestId", .string(requestId)), ("outcome", .string(outcome))]
        case let .error(text, agent):
            pairs.append(("t", .string("error")))
            add("agent", agent)
            pairs.append(("text", .string(text)))
        }
        return .object(pairs)
    }

    /// JavaScript's `String(x)` for the values JSON can carry; nil for null or missing.
    private static func string(_ value: Any?) -> String? {
        switch value {
        case let s as String: s
        case let n as NSNumber: n.stringValue
        default: nil
        }
    }
}

/// An approval, question or open-Yo card from the core.
public struct RequestCard: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case approval, question
        case openYo = "open_yo"
    }

    public var requestId: String
    public var kind: Kind
    public var title: String
    public var detail: String
    public var options: [String]
    public var agent: String?

    public init(requestId: String, kind: Kind, title: String, detail: String = "", options: [String] = [],
                agent: String? = nil) {
        self.requestId = requestId
        self.kind = kind
        self.title = title
        self.detail = detail
        self.options = options
        self.agent = agent
    }
}

extension Date {
    /// Milliseconds since 1970, as JavaScript counts time.
    public var millis: Int64 { Int64((timeIntervalSince1970 * 1000).rounded()) }

    public init(millis: Double) {
        self.init(timeIntervalSince1970: millis / 1000)
    }
}
