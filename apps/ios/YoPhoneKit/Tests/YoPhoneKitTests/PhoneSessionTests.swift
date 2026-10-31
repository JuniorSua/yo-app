import Foundation
import Testing
@testable import YoPhoneKit

@MainActor
@Suite struct PhoneSessionTests {
    let core = FakeCore()
    let store = MemorySessionStore()
    let clock = TestClock()

    private func makeSession(_ store: MemorySessionStore? = nil) throws -> PhoneSession {
        let clock = clock
        return try PhoneSession(link: core.link, transport: core, store: store ?? self.store, now: { clock.now })
    }

    private func collect(_ session: PhoneSession) -> EventLog {
        let log = EventLog()
        session.onEvent = { log.events.append($0) }
        return log
    }

    @Test func sendGoesFromSendingToSentToDelivered() async throws {
        let session = try makeSession()
        await session.send("  Book a table  ")
        let item = try #require(session.items.first)
        #expect(item.kind == .mine && item.text == "Book a table" && item.delivery == .sent)

        let posted = await core.received
        #expect(posted.count == 1)
        let msg = fields(posted[0])
        #expect(msg["t"] == "msg" && msg["id"] == item.id && msg["text"] == "Book a table")
        #expect(msg["at"] == String(clock.now.millis))

        await core.emit(.ack(ids: [item.id]))
        await session.pollOnce()
        #expect(session.items.first?.delivery == .delivered)
        #expect(store.snapshot?.items.first?.delivery == .delivered)
        #expect(store.snapshot?.cursor == 1)
    }

    @Test func emptyTextIsNotSentAndLongTextIsCut() async throws {
        let session = try makeSession()
        await session.send("   \n ")
        #expect(session.items.isEmpty)
        await session.send(String(repeating: "a", count: 9000))
        #expect(session.items.first?.text.count == 8000)
    }

    @Test func failedSendShowsWhyAndRetryKeepsTheID() async throws {
        let session = try makeSession()
        await core.set(postError: .rateLimited(retryAfter: 30))
        await session.send("hi")
        let failed = try #require(session.items.first)
        #expect(failed.delivery == .failed)
        #expect(failed.failure == "Yo has a lot waiting. Try again in a minute.")

        await core.set(postError: nil)
        await session.retry(failed.id)
        #expect(session.items.first?.delivery == .sent && session.items.first?.failure == nil)
        #expect(fields(await core.received[0])["id"] == failed.id)
    }

    @Test func revokedOnSendTearsDown() async throws {
        let session = try makeSession()
        let log = collect(session)
        await core.set(postError: .revoked)
        await session.send("hi")
        #expect(session.isRevoked)
        #expect(log.events.contains(.revoked))
    }

    @Test func revokedOnPollTearsDown() async throws {
        let session = try makeSession()
        let log = collect(session)
        await core.set(getError: .revoked)
        await session.pollOnce()
        #expect(session.isRevoked)
        #expect(log.events == [.revoked])
    }

    @Test func dropsForgedItemsWithoutMovingTheCursorPastThem() async throws {
        let session = try makeSession()
        await core.emit(.reply(id: "ok", text: "real", at: nil, agent: "Yo"))
        let forged = await core.seal(.reply(id: "x", text: "forged", at: nil, agent: "Yo"), n: 9_999_999)
        await core.push(box: forged, sig: nil)
        await core.push(box: forged, sig: Vector.shared.sig)
        await session.pollOnce()
        #expect(session.items.map(\.text) == ["real"])
        #expect(session.cursor == 1)
        #expect(store.snapshot?.lastN == 1_001)

        // The core's next reply still gets through, after the forged ones.
        await core.emit(.reply(id: "next", text: "next", at: nil, agent: "Yo"))
        await session.pollOnce()
        #expect(session.items.map(\.text) == ["real", "next"])
        #expect(session.cursor == 4)
    }

    @Test func dropsAReplayedReply() async throws {
        let session = try makeSession()
        await core.emit(.reply(id: "a", text: "once", at: nil, agent: "Yo"), n: 50)
        await session.pollOnce()
        // The relay serves the same signed envelope again under a new seq.
        let replayed = await core.outbox[0]
        await core.push(box: replayed.box, sig: replayed.sig)
        await core.emit(.reply(id: "b", text: "older", at: nil, agent: "Yo"), n: 40)
        await session.pollOnce()
        #expect(session.items.map(\.text) == ["once"])
        #expect(session.cursor == 1 && session.lastN == 50)
    }

    @Test func followsMorePagesAndRewindsOnReset() async throws {
        let session = try makeSession()
        for i in 1...5 { await core.emit(.reply(id: "r\(i)", text: "\(i)", at: nil, agent: "Yo")) }
        await core.set(pageSize: 2)
        await session.pollOnce()
        #expect(session.items.count == 5)
        #expect(await core.getOutCalls == [0, 2, 4])
        #expect(session.cursor == 5)

        // The mailbox expired: the relay's counter restarted below our cursor.
        await core.clearOutbox()
        await core.set(pageSize: nil)
        await core.emit(.reply(id: "fresh", text: "after reset", at: nil, agent: "Yo"))
        await core.set(reset: true)
        await session.pollOnce()
        #expect(session.items.last?.text == "after reset")
        #expect(session.cursor == 1)
    }

    @Test func workingQueuedIdleAndStop() async throws {
        let session = try makeSession()
        await core.emit(.status(state: .working, detail: "Checking flights", agent: "Yo"))
        await session.pollOnce()
        #expect(session.workingText == "Checking flights…")

        await session.stop()
        #expect(session.workingText == "Stopping…")
        #expect(fields(await core.received.last!)["t"] == "stop")

        await core.emit(.status(state: .queued, detail: "", agent: "Yo"))
        await session.pollOnce()
        #expect(session.working?.state == .queued && session.working?.stopping == true)

        await core.emit(.status(state: .idle, detail: "", agent: "Yo"))
        await session.pollOnce()
        #expect(session.working == nil && session.workingText == nil)
    }

    @Test func workingTextUsesTheAgentName() async throws {
        let session = try makeSession()
        await core.emit(.hello(agentName: "Pepe"))
        await core.emit(.status(state: .working, detail: "", agent: "Pepe"))
        await session.pollOnce()
        #expect(session.agentName == "Pepe")
        #expect(session.workingText == "Pepe is working…")
        await core.emit(.status(state: .queued, detail: "", agent: "Pepe"))
        await session.pollOnce()
        #expect(session.workingText == "Pepe will get to this next")
    }

    @Test func staleWorkingGoesAway() async throws {
        let session = try makeSession()
        await core.emit(.status(state: .working, detail: "Reading", agent: "Yo"))
        await session.pollOnce()
        clock.advance(301)
        await session.pollOnce()
        #expect(session.working == nil)
    }

    @Test func repliesAreDedupedAndMarkEverythingSentAsDelivered() async throws {
        let session = try makeSession()
        let log = collect(session)
        await session.send("one")
        await core.emit(.status(state: .working, detail: "x", agent: "Yo"))
        await core.emit(.reply(id: "r1", text: "**Done**", at: Date(millis: 5), agent: "Yo"))
        await core.emit(.reply(id: "r1", text: "**Done**", at: Date(millis: 5), agent: "Yo"))
        await session.pollOnce()
        #expect(session.items.filter { $0.kind == .yo }.count == 1)
        #expect(session.items.first?.delivery == .delivered)
        #expect(session.working == nil)
        #expect(log.events == [.sent, .reply(text: "**Done**")])
    }

    @Test func cardsUpsertAndResolve() async throws {
        let session = try makeSession()
        let card = RequestCard(requestId: "q1", kind: .approval, title: "Buy 2 tickets?", detail: "$38.50", agent: "Yo")
        await core.emit(.request(card))
        await session.pollOnce()
        let firstAt = try #require(session.items.first?.at)

        clock.advance(60)
        var updated = card
        updated.title = "Buy 2 tickets for Friday?"
        await core.emit(.request(updated))
        await session.pollOnce()
        #expect(session.items.count == 1)
        #expect(session.items[0].card?.title == "Buy 2 tickets for Friday?")
        #expect(session.items[0].at == firstAt)

        await session.respond(to: "q1", decision: .approve)
        #expect(session.items[0].pending == "approve")
        let respond = fields(await core.received.last!)
        #expect(respond["t"] == "respond" && respond["requestId"] == "q1" && respond["decision"] == "approve")
        #expect(respond["answer"] == nil)

        // A second tap while it's on its way does nothing.
        await session.respond(to: "q1", decision: .deny)
        #expect(await core.received.count == 1)

        await core.emit(.resolved(requestId: "q1", outcome: "Approved"))
        await session.pollOnce()
        #expect(session.items[0].outcome == "Approved" && session.items[0].pending == nil)
    }

    @Test func questionAnswersCarryTheOption() async throws {
        let session = try makeSession()
        await core.emit(.request(RequestCard(requestId: "q2", kind: .question, title: "Which?", options: ["A", "B"])))
        await session.pollOnce()
        await session.respond(to: "q2", decision: .approve, answer: "B")
        #expect(session.items[0].pending == "B")
        #expect(fields(await core.received.last!)["answer"] == "B")
    }

    @Test func failedRespondClearsPendingAndSaysWhy() async throws {
        let session = try makeSession()
        let log = collect(session)
        await core.emit(.request(RequestCard(requestId: "q3", kind: .approval, title: "OK?")))
        await session.pollOnce()
        await core.set(postError: .offline)
        await session.respond(to: "q3", decision: .deny)
        #expect(session.items[0].pending == nil)
        #expect(log.events.last == .notice("No connection."))
    }

    @Test func errorsBecomeNotesAndStopWorking() async throws {
        let session = try makeSession()
        await core.emit(.status(state: .working, detail: "x", agent: "Yo"))
        await core.emit(.error(text: "Yo is busy. Send it again in a minute.", agent: "Yo"))
        await session.pollOnce()
        #expect(session.items.last?.kind == .error)
        #expect(session.items.last?.text == "Yo is busy. Send it again in a minute.")
        #expect(session.working == nil)
    }

    @Test func presenceFollowsSeen() async throws {
        let session = try makeSession()
        #expect(session.statusText(at: clock.now) == "Connecting…")
        await core.set(seen: Double(clock.now.addingTimeInterval(-30).millis))
        await session.pollOnce()
        #expect(session.isOnline(at: clock.now))
        #expect(session.statusText(at: clock.now) == "Online")
        #expect(session.bannerText(at: clock.now) == nil)

        await core.emit(.status(state: .working, detail: "", agent: "Yo"))
        await session.pollOnce()
        #expect(session.statusText(at: clock.now) == "Working")

        clock.advance(600)
        #expect(session.statusText(at: clock.now) == "Offline · seen 11 min ago")
        #expect(session.bannerText(at: clock.now) == "Yo's computer is offline; it'll get your message when it's back.")

        await core.set(seen: nil)
        await session.pollOnce()
        #expect(session.statusText(at: clock.now) == "Offline")
    }

    @Test func connectionProblemsShowABanner() async throws {
        let session = try makeSession()
        await core.set(getError: .offline)
        await session.pollOnce()
        #expect(session.issue == .offline)
        #expect(session.statusText(at: clock.now) == "No connection")
        #expect(session.bannerText(at: clock.now) == "No connection right now. Messages will send when you're back online.")

        await core.set(getError: .rateLimited(retryAfter: 20))
        await session.pollOnce()
        #expect(session.issue == .busy)
        #expect(session.bannerText(at: clock.now) == "The relay is busy. Trying again in a moment.")

        await core.set(getError: nil)
        await session.pollOnce()
        #expect(session.issue == nil)
    }

    @Test func a401MeansTheLinkIsOff() async throws {
        let session = try makeSession()
        let log = collect(session)
        await core.set(getError: .unauthorized)
        await session.pollOnce()
        #expect(session.isRevoked)
        #expect(log.events == [.revoked])
    }

    @Test func helloIsSentOnPairAndAtMostEveryThirtyMinutes() async throws {
        let session = try makeSession()
        await session.sayHello(force: true)
        let hello = fields(await core.received[0])
        #expect(hello["t"] == "hello" && hello["device"] == "iPhone (Yo app)")
        await session.sayHello()
        #expect(await core.received.count == 1)
        clock.advance(31 * 60)
        await session.sayHello()
        #expect(await core.received.count == 2)
        #expect(store.snapshot?.lastHello == clock.now)
    }

    @Test func restoresHistoryButNotWhatWasInFlight() async throws {
        let card = RequestCard(requestId: "q", kind: .approval, title: "OK?")
        var pendingCard = ChatItem.card(card, at: clock.now)
        pendingCard.pending = "approve"
        let saved = MemorySessionStore(SessionSnapshot(
            items: [.mine(id: "m", text: "hi", at: clock.now, delivery: .sending), pendingCard],
            cursor: 42, agentName: "Pepe", pairedAt: clock.now
        ))
        let session = try makeSession(saved)
        #expect(session.items[0].delivery == .failed)
        #expect(session.items[1].pending == nil)
        #expect(session.cursor == 42 && session.agentName == "Pepe" && session.pairedAt == clock.now)
        await session.pollOnce()
        #expect(await core.getOutCalls == [42])
    }

    @Test func keepsTheLastThreeHundredItems() async throws {
        let session = try makeSession()
        for i in 0..<305 { await core.emit(.reply(id: "r\(i)", text: "\(i)", at: nil, agent: "Yo")) }
        await session.pollOnce()
        #expect(session.items.count == 300)
        #expect(session.items.first?.text == "5")
    }

    @Test func pollsOnItsOwnOnlyWhileActive() async throws {
        let session = try PhoneSession(link: core.link, transport: core, store: store,
                                       config: .init(pollInterval: .milliseconds(20)))
        session.activate()
        try await Task.sleep(for: .milliseconds(200))
        session.deactivate()
        let calls = await core.getOutCalls.count
        #expect(calls >= 3)
        try await Task.sleep(for: .milliseconds(150))
        #expect(await core.getOutCalls.count <= calls + 1)
    }
}

@MainActor
final class EventLog {
    var events: [SessionEvent] = []
}
