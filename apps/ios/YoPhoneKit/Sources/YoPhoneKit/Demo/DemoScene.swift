import Foundation

/// Fixed, good-looking states for App Store screenshots (`-YoScreenshotScene <name>`). Each one is a demo session
/// with history already in place, so the screens look like a Yo that has been in use for a while.
public enum DemoScene: String, CaseIterable, Sendable {
    case welcome, chat, approval, drive, settings

    /// The words on screen in Drive mode's countdown.
    public static let driveTranscript = "Hold the Peregrine Air flight and add it to my calendar"

    /// History for the scene, timed on the morning of `day`; nil for the welcome screen.
    public func snapshot(on day: Date, calendar: Calendar = .current) -> SessionSnapshot? {
        func at(_ minute: Int) -> Date {
            calendar.date(bySettingHour: 9, minute: minute, second: 0, of: day) ?? day
        }
        let paired = calendar.date(byAdding: .day, value: -12, to: day)
        switch self {
        case .welcome:
            return nil
        case .chat, .settings:
            return SessionSnapshot(items: [
                .mine(id: "s1", text: "Anything important in my inbox this morning?", at: at(30), delivery: .delivered),
                .yo(id: "s2", text: Script.inbox.reply, at: at(31)),
                .mine(id: "s3", text: "Yes, keep it short and say we'd like another year.", at: at(32), delivery: .delivered),
                .yo(id: "s4", text: "Done. It's in your drafts:\n\n*Happy to renew for another year on the same terms. Could we sign next week?*", at: at(32)),
                .mine(id: "s5", text: "Also book a table for 4 on Friday, somewhere Italian", at: at(39), delivery: .delivered),
            ], agentName: DemoCore.agentName, pairedAt: paired, lastHello: at(39))
        case .approval:
            return SessionSnapshot(items: [
                .mine(id: "a1", text: "Book a table for 4 on Friday, somewhere Italian", at: at(38), delivery: .delivered),
                .yo(id: "a2", text: Script.table.reply, at: at(39)),
                .card(Script.tableCard.request, at: at(39)),
            ], agentName: DemoCore.agentName, pairedAt: paired, lastHello: at(39))
        case .drive:
            return SessionSnapshot(items: [
                .mine(id: "d1", text: "Compare flights to Denver on Friday morning", at: at(36), delivery: .delivered),
                .yo(id: "d2", text: Script.flights.reply, at: at(37)),
            ], agentName: DemoCore.agentName, pairedAt: paired, lastHello: at(37))
        }
    }

    /// What's waiting in the pretend mailbox when the scene opens.
    public var opening: [OutMessage] {
        switch self {
        case .chat, .settings:
            [.status(state: .working, detail: "Checking tables near you", agent: DemoCore.agentName)]
        default:
            []
        }
    }

    /// Cards in the history that can still be answered.
    public var openCards: [RequestCard] {
        self == .approval ? [Script.tableCard.request] : []
    }
}
