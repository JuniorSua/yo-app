import Foundation
import Observation

/// Whether Yo's computer has been polling the relay.
public enum Presence: Equatable, Sendable {
    /// Not polled yet.
    case unknown
    /// The core hasn't polled in the last 10 minutes.
    case away
    /// The core last polled at this time.
    case seen(Date)
}

/// Yo's typing indicator.
public struct WorkingState: Equatable, Sendable {
    public var state: OutMessage.WorkState
    /// A short activity label, e.g. "Checking flights".
    public var detail: String
    public var since: Date
    /// The owner tapped Stop and it's on its way.
    public var stopping: Bool
}

public enum ConnectionIssue: Equatable, Sendable {
    /// The relay couldn't be reached.
    case offline
    /// The relay asked the phone to slow down (429).
    case busy
}

/// Things the app reacts to with sound, speech or a toast.
public enum SessionEvent: Equatable, Sendable {
    case sent
    case reply(text: String)
    case card(RequestCard)
    case failure(text: String)
    case notice(String)
    case revoked
}

/// One paired phone talking to its Yo: the same state machine as phone/app.js.
///
/// It says hello on open, sends with random ids, tracks Sent → Delivered through `ack`, persists the cursor,
/// shows working/queued status, and turns replies, cards, resolutions and errors into `items`. It polls only while
/// `activate()`d (the app is in the foreground).
@MainActor
@Observable
public final class PhoneSession {
    public struct Config: Sendable {
        public var pollInterval: Duration
        public var maxPollInterval: Duration
        public var helloEvery: TimeInterval
        /// The device label sent with `hello`.
        public var device: String

        public init(pollInterval: Duration = .seconds(3), maxPollInterval: Duration = .seconds(15),
                    helloEvery: TimeInterval = 30 * 60, device: String = "iPhone (Yo app)") {
            self.pollInterval = pollInterval
            self.maxPollInterval = maxPollInterval
            self.helloEvery = helloEvery
            self.device = device
        }
    }

    public static let onlineWindow: TimeInterval = 5 * 60
    public static let workingStaleAfter: TimeInterval = 5 * 60
    public static let maxTextLength = 8000
    static let historyMax = 300
    static let maxPagesPerPoll = 25

    public let link: PhoneLink
    public private(set) var items: [ChatItem]
    public private(set) var agentName: String
    public private(set) var pairedAt: Date?
    public private(set) var presence: Presence = .unknown
    public private(set) var issue: ConnectionIssue?
    public private(set) var working: WorkingState?
    public private(set) var isRevoked = false
    public private(set) var cursor: Int
    public private(set) var lastN: Int64?

    @ObservationIgnored public var onEvent: ((SessionEvent) -> Void)?

    @ObservationIgnored private let keys: PhoneKeys
    @ObservationIgnored private let verifier: ReplyVerifier
    @ObservationIgnored private let transport: any RelayTransport
    @ObservationIgnored private let store: any SessionStore
    @ObservationIgnored private let config: Config
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var lastHello: Date?
    @ObservationIgnored private var isSayingHello = false
    /// Closed sessions never write to the store again (the app forgot the link, or it was turned off).
    @ObservationIgnored private var isClosed = false
    @ObservationIgnored private var lastSaved: SessionSnapshot?
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var isPolling = false
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var backoff: Duration
    @ObservationIgnored private var requestedDelay: Duration?

    public init(link: PhoneLink, transport: any RelayTransport, store: any SessionStore, config: Config = Config(),
                now: @escaping () -> Date = Date.init) throws {
        guard let verifier = ReplyVerifier(signPub: link.signPub) else { throw PhoneCryptoError.badSecret }
        keys = try PhoneKeys(secret: link.secret)
        self.verifier = verifier
        self.link = link
        self.transport = transport
        self.store = store
        self.config = config
        self.now = now
        backoff = config.pollInterval
        let snapshot = store.load() ?? SessionSnapshot()
        // Anything still sending when the app last closed never made it; cards wait for a fresh answer.
        items = snapshot.items.map { item in
            var item = item
            if item.delivery == .sending { item.delivery = .failed }
            item.pending = nil
            return item
        }
        cursor = snapshot.cursor
        lastN = snapshot.lastN
        lastSaved = snapshot
        agentName = snapshot.agentName
        pairedAt = snapshot.pairedAt
        lastHello = snapshot.lastHello
    }

    // MARK: - Lifecycle

    /// The app came to the foreground: poll now and keep polling.
    public func activate() {
        guard !isRevoked, !isClosed else { return }
        isActive = true
        schedule(.zero)
    }

    /// Stops for good: no more polling, and nothing more is written to the store, even by a send or poll that's
    /// still finishing. Call it before clearing the store.
    public func close() {
        isClosed = true
        deactivate()
    }

    /// The app left the foreground: stop polling.
    public func deactivate() {
        isActive = false
        timer?.cancel()
        timer = nil
    }

    /// Tells the core who's here. Without `force` it's sent at most every 30 minutes.
    public func sayHello(force: Bool = false) async {
        if !force, let lastHello, now().timeIntervalSince(lastHello) < config.helloEvery { return }
        if !force, isSayingHello { return }
        isSayingHello = true
        defer { isSayingHello = false }
        do {
            try await sendIn(.hello(id: randomMessageID(), device: config.device))
            lastHello = now()
            persist()
            pollSoon(.milliseconds(800))
        } catch {
            // try again next launch
        }
    }

    // MARK: - Sending

    public func send(_ raw: String) async {
        let text = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxTextLength))
        guard !text.isEmpty else { return }
        let item = ChatItem.mine(id: randomMessageID(), text: text, at: now())
        append(item)
        persist()
        onEvent?(.sent)
        await deliver(item.id)
    }

    /// Sends a failed message again with the same id, so the core still dedupes it.
    public func retry(_ id: String) async {
        await deliver(id)
    }

    public func respond(to requestId: String, decision: InMessage.Decision, answer: String? = nil) async {
        guard let i = cardIndex(requestId), items[i].pending == nil, items[i].outcome == nil else { return }
        items[i].pending = answer ?? decision.rawValue
        do {
            try await sendIn(.respond(id: randomMessageID(), requestId: requestId, decision: decision, answer: answer))
            pollSoon(.milliseconds(800))
        } catch {
            if let i = cardIndex(requestId) { items[i].pending = nil }
            onEvent?(.notice(error.sendFailureText))
        }
    }

    /// Stops what Yo is doing for this phone.
    public func stop() async {
        guard working != nil else { return }
        working?.stopping = true
        do {
            try await sendIn(.stop(id: randomMessageID()))
            pollSoon(.milliseconds(800))
        } catch {
            working?.stopping = false
            onEvent?(.notice(error.sendFailureText))
        }
    }

    private func deliver(_ id: String) async {
        guard let i = mineIndex(id) else { return }
        items[i].delivery = .sending
        items[i].failure = nil
        let message = InMessage.msg(id: id, text: items[i].text, at: items[i].at)
        do {
            try await sendIn(message)
            if let i = mineIndex(id), items[i].delivery == .sending { items[i].delivery = .sent }
        } catch {
            if let i = mineIndex(id) {
                items[i].delivery = .failed
                items[i].failure = error.sendFailureText
            }
        }
        persist()
        pollSoon(.milliseconds(1200))
    }

    private func sendIn(_ message: InMessage) async throws(RelayError) {
        guard !isRevoked else { throw .revoked }
        let envelope: String
        do {
            envelope = try keys.seal(message.json.data, .in)
        } catch {
            throw .http(status: 0, message: "Couldn't lock the message")
        }
        do {
            try await transport.postIn(envelope)
        } catch {
            if error.isTurnedOff { markRevoked() }
            throw error
        }
    }

    // MARK: - Polling

    /// Polls soon, or right after the poll that's running now.
    public func pollSoon(_ delay: Duration = .milliseconds(300)) {
        if isPolling {
            requestedDelay = min(requestedDelay ?? delay, delay)
        } else {
            schedule(delay)
        }
    }

    private func schedule(_ delay: Duration) {
        timer?.cancel()
        timer = nil
        guard isActive, !isRevoked else { return }
        timer = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled else { return }
            // The poll runs in its own task, so rescheduling never cancels a request that's in flight.
            Task { await self?.pollOnce() }
        }
    }

    /// Fetches every waiting `out` item and handles the ones `Inbox` accepts (signed by the core, counter going
    /// up), in order. Pages are fetched after the highest seq seen; the saved cursor only moves past accepted items.
    public func pollOnce() async {
        guard !isRevoked, !isClosed, !isPolling else { return }
        isPolling = true
        do throws(RelayError) {
            var after = cursor
            for _ in 0..<Self.maxPagesPerPoll {
                let page = try await transport.getOut(after: after)
                if page.reset {
                    cursor = 0
                    after = 0
                }
                let accepted = Inbox.accept(page.items, cursor: cursor, lastN: lastN, verifier: verifier, keys: keys)
                cursor = accepted.cursor
                lastN = accepted.lastN
                accepted.messages.forEach(handle)
                presence = page.seen.map { .seen(Date(millis: $0)) } ?? .away
                persist()
                if !page.more || page.items.isEmpty || isRevoked || accepted.maxSeq <= after { break }
                after = accepted.maxSeq
            }
            issue = nil
            backoff = config.pollInterval
        } catch {
            if error.isTurnedOff {
                isPolling = false
                markRevoked()
                return
            }
            if case .rateLimited = error { issue = .busy } else { issue = .offline }
            backoff = min(config.maxPollInterval, backoff * 1.6)
            if case let .rateLimited(retryAfter?) = error, retryAfter.isFinite {
                backoff = max(backoff, .seconds(min(max(retryAfter, 0), RelayError.maxRetryAfter)))
            }
        }
        isPolling = false
        if let working, now().timeIntervalSince(working.since) > Self.workingStaleAfter { self.working = nil }
        let normal = issue == nil ? config.pollInterval : backoff
        let next = requestedDelay.map { min($0, normal) } ?? normal
        requestedDelay = nil
        schedule(next)
    }

    private func markRevoked() {
        guard !isRevoked else { return }
        isRevoked = true
        working = nil
        close()
        onEvent?(.revoked)
    }

    // MARK: - Incoming

    func handle(_ message: OutMessage) {
        switch message {
        case let .hello(name):
            if let name, !name.isEmpty { agentName = name }
        case let .ack(ids):
            let ids = Set(ids)
            for i in items.indices where items[i].kind == .mine && ids.contains(items[i].id) {
                items[i].delivery = .delivered
            }
        case let .status(state, detail, _):
            if state == .idle {
                working = nil
            } else {
                working = WorkingState(state: state, detail: detail, since: now(), stopping: working?.stopping ?? false)
            }
        case let .reply(id, text, at, agent):
            if let id, items.contains(where: { $0.kind == .yo && $0.id == id }) { return }
            append(.yo(id: id ?? randomMessageID(), text: text, at: at ?? now(), agent: agent))
            working = nil
            // A reply means everything before it reached Yo, even if the ack got lost.
            for i in items.indices where items[i].kind == .mine && items[i].delivery == .sent {
                items[i].delivery = .delivered
            }
            onEvent?(.reply(text: text))
        case let .request(card):
            if let i = cardIndex(card.requestId) {
                items[i].card = card
                items[i].text = card.title
            } else {
                append(.card(card, at: now()))
                onEvent?(.card(card))
            }
        case let .resolved(requestId, outcome):
            if let i = cardIndex(requestId) {
                items[i].outcome = outcome
                items[i].pending = nil
            }
        case let .error(text, _):
            append(.error(id: randomMessageID(), text: text, at: now()))
            working = nil
            onEvent?(.failure(text: text))
        }
    }

    // MARK: - What the screen shows

    public func isOnline(at date: Date) -> Bool {
        if case let .seen(seen) = presence { return date.timeIntervalSince(seen) < Self.onlineWindow }
        return false
    }

    /// The line under Yo's name: "Online", "Working", "Offline · seen 5 min ago"…
    public func statusText(at date: Date) -> String {
        let online = isOnline(at: date)
        switch presence {
        case .unknown: return issue == .offline ? "No connection" : "Connecting…"
        case _ where working != nil && online: return "Working"
        case _ where online: return "Online"
        case let .seen(seen): return "Offline · seen \(Self.ago(seen, now: date))"
        case .away: return "Offline"
        }
    }

    /// "Online", or when the computer was last seen.
    public func lastSeenText(at date: Date) -> String {
        switch presence {
        case .unknown: "Checking…"
        case _ where isOnline(at: date): "Online"
        case let .seen(seen): Self.ago(seen, now: date)
        case .away: "Offline"
        }
    }

    /// The strip under the header, or nil when everything's fine.
    public func bannerText(at date: Date) -> String? {
        switch issue {
        case .offline: return "No connection right now. Messages will send when you're back online."
        case .busy: return "The relay is busy. Trying again in a moment."
        case nil: break
        }
        if presence != .unknown, !isOnline(at: date) {
            return "\(agentName)'s computer is offline; it'll get your message when it's back."
        }
        return nil
    }

    /// The working row's text, or nil when Yo is idle.
    public var workingText: String? {
        guard let working else { return nil }
        if working.stopping { return "Stopping…" }
        if working.state == .queued { return "\(agentName) will get to this next" }
        return working.detail.isEmpty ? "\(agentName) is working…" : "\(working.detail)…"
    }

    static func ago(_ date: Date, now: Date) -> String {
        let s = max(0, (now.timeIntervalSince(date)).rounded())
        if s < 60 { return "just now" }
        let m = (s / 60).rounded()
        if m < 60 { return "\(Int(m)) min ago" }
        let h = (m / 60).rounded()
        if h < 24 { return "\(Int(h)) hr ago" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    // MARK: - Helpers

    private func append(_ item: ChatItem) {
        items.append(item)
        if items.count > Self.historyMax { items.removeFirst(items.count - Self.historyMax) }
    }

    /// Saves the conversation, unless the session is closed or nothing changed since the last save.
    private func persist() {
        guard !isClosed else { return }
        let snapshot = SessionSnapshot(items: items, cursor: cursor, lastN: lastN, agentName: agentName,
                                       pairedAt: pairedAt, lastHello: lastHello)
        guard snapshot != lastSaved else { return }
        store.save(snapshot)
        lastSaved = snapshot
    }

    private func mineIndex(_ id: String) -> Int? {
        items.firstIndex { $0.kind == .mine && $0.id == id }
    }

    private func cardIndex(_ requestId: String) -> Int? {
        items.firstIndex { $0.kind == .card && $0.id == requestId }
    }
}
