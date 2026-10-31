import Foundation
import Testing
@testable import Yo

@MainActor
@Suite struct DriveControllerTests {
    let listener = FakeListener()

    private func makeDrive() -> (DriveController, SentLog) {
        let drive = DriveController(listener: listener, speaker: Speaker())
        let log = SentLog()
        drive.onSend = { log.texts.append($0) }
        drive.setOn(true, quiet: true)
        return (drive, log)
    }

    @Test func talkPauseCountdownSend() async throws {
        let (drive, log) = makeDrive()
        drive.micTapped()
        #expect(drive.phase == .listening && listener.started == 1)
        listener.hear("Book a table for four")
        #expect(drive.transcript == "Book a table for four")
        listener.end(.finished)
        #expect(drive.phase == .countdown(3))
        try await Task.sleep(for: .milliseconds(3300))
        #expect(log.texts == ["Book a table for four"])
        #expect(drive.phase == .idle && drive.transcript.isEmpty)
        #expect(drive.hint == "Sent. Tap to talk again")
    }

    @Test func tappingTheCountdownCancels() async throws {
        let (drive, log) = makeDrive()
        drive.micTapped()
        listener.hear("never mind")
        drive.micTapped()
        #expect(listener.stopped == 1)
        #expect(drive.phase == .countdown(3))
        drive.cancelCountdown()
        try await Task.sleep(for: .milliseconds(3300))
        #expect(log.texts.isEmpty)
        #expect(drive.hint == "Canceled. Tap to talk")
    }

    @Test func silenceEndsListening() async throws {
        let (drive, _) = makeDrive()
        drive.micTapped()
        listener.hear("hello")
        try await Task.sleep(for: .milliseconds(2000))
        #expect(listener.stopped == 1)
        #expect(drive.phase == .countdown(3))
        drive.setOn(false)
    }

    @Test func nothingHeardOrNotAllowed() {
        let (drive, _) = makeDrive()
        drive.micTapped()
        listener.end(.finished)
        #expect(drive.phase == .idle && drive.hint == "Didn't catch that. Tap to try again")
        drive.micTapped()
        listener.end(.denied)
        #expect(drive.hint == "Allow the microphone and speech recognition for Yo in Settings, then tap again")
    }

    @Test func turningOffStopsEverything() {
        let (drive, _) = makeDrive()
        drive.micTapped()
        listener.hear("half a thought")
        drive.setOn(false)
        #expect(!drive.isOn && drive.phase == .idle && drive.transcript.isEmpty)
    }
}

@MainActor
final class SentLog {
    var texts: [String] = []
}
