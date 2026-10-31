import Foundation
import Testing
@testable import YoPhoneKit

@MainActor
@Suite struct DemoTests {
    /// Polls until `done` holds, for the demo's background turns.
    private func pollUntil(_ session: PhoneSession, _ done: () -> Bool) async throws {
        for _ in 0..<100 where !done() {
            await session.pollOnce()
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(done())
    }

    @Test func aTableRequestEndsInAnApprovalYouCanApprove() async throws {
        let demo = DemoCore(step: .zero)
        let session = try PhoneSession(link: demo.link, transport: demo, store: MemorySessionStore())
        await session.sayHello(force: true)
        await session.send("Book a table for 4 on Friday")
        try await pollUntil(session) { session.items.contains { $0.kind == .card } }
        #expect(session.items.first?.delivery == .delivered)
        #expect(session.items.contains { $0.kind == .yo && $0.text.contains("Trattoria Sole") })
        #expect(session.isOnline(at: Date()))

        await session.respond(to: "demo-table", decision: .approve)
        try await pollUntil(session) { session.items.last?.text.hasPrefix("Booked") == true }
        #expect(session.items.first { $0.kind == .card }?.outcome == "Approved")
    }

    @Test func flightsAskAQuestionAndStopStops() async throws {
        let demo = DemoCore(step: .zero)
        let session = try PhoneSession(link: demo.link, transport: demo, store: MemorySessionStore())
        await session.send("compare flights to Denver")
        try await pollUntil(session) { session.items.contains { $0.card?.kind == .question } }
        await session.respond(to: "demo-flight", decision: .approve, answer: "Sunline 9:40 am · $214")
        try await pollUntil(session) { session.items.last?.text.contains("Sunline 9:40 am") == true }
        #expect(session.items.first { $0.kind == .card }?.outcome == "Picked “Sunline 9:40 am · $214”")
    }

    @Test func stopEndsATurn() async throws {
        let demo = DemoCore(step: .seconds(5))
        let session = try PhoneSession(link: demo.link, transport: demo, store: MemorySessionStore())
        await session.send("hello")
        try await pollUntil(session) { session.working != nil }
        await session.stop()
        try await pollUntil(session) { session.working == nil }
        #expect(session.items.last?.text == "Okay, I stopped.")
    }

    @Test func everySceneHasContentAndOpensCleanly() async throws {
        for scene in DemoScene.allCases {
            let snapshot = scene.snapshot(on: Date())
            #expect((snapshot == nil) == (scene == .welcome))
            let demo = DemoCore(step: .zero, opening: scene.opening, openCards: scene.openCards)
            let session = try PhoneSession(link: demo.link, transport: demo, store: MemorySessionStore(snapshot))
            await session.pollOnce()
            if scene == .chat { #expect(session.workingText == "Checking tables near you…") }
        }
    }
}
