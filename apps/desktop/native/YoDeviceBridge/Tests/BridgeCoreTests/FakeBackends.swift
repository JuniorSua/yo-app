import CoreGraphics
import Foundation

@testable import BridgeCore

/// In-memory Contacts store. Records which searches ran; never touches the real framework.
final class FakeContacts: ContactsBackend {
    var currentStatus: AccessStatus = .granted
    var statusAfterRequest: AccessStatus = .granted
    var requestTimeouts: [TimeInterval] = []
    var byName: [String: [ContactRecord]] = [:]
    var byPhone: [String: [ContactRecord]] = [:]
    var byEmail: [String: [ContactRecord]] = [:]
    var searches: [String] = []

    func status() -> AccessStatus { currentStatus }

    func requestAccess(timeout: TimeInterval) -> AccessStatus {
        requestTimeouts.append(timeout)
        currentStatus = statusAfterRequest
        return currentStatus
    }

    func search(name: String) throws(BridgeError) -> [ContactRecord] {
        searches.append("name")
        return byName[name] ?? []
    }

    func search(phone: String) throws(BridgeError) -> [ContactRecord] {
        searches.append("phone")
        return byPhone[phone] ?? []
    }

    func search(email: String) throws(BridgeError) -> [ContactRecord] {
        searches.append("email")
        return byEmail[email] ?? []
    }
}

/// In-memory EventKit. Occurrences of a recurring series share an id and differ by occurrenceDate.
final class FakeCalendar: CalendarBackend {
    var eventStatus: AccessStatus = .granted
    var reminderStatus: AccessStatus = .granted
    var statusAfterRequest: AccessStatus = .granted
    var requests: [(CalendarEntity, TimeInterval)] = []
    var refreshes = 0
    var calendars: [CalendarRecord] = []
    var lists: [CalendarRecord] = []
    var events: [EventRecord] = []
    var reminders: [ReminderRecord] = []
    var createdEvents: [EventDraft] = []
    var updates: [(EventRecord, EventChanges)] = []
    var createdReminders: [ReminderDraft] = []
    var completions: [(String, Bool)] = []
    var lastEventQuery: (Date, Date, [String]?)?
    let savedAt = Date(timeIntervalSince1970: 1_800_000_000.123)

    func status(_ entity: CalendarEntity) -> AccessStatus { entity == .event ? eventStatus : reminderStatus }

    func requestAccess(_ entity: CalendarEntity, timeout: TimeInterval) -> AccessStatus {
        requests.append((entity, timeout))
        if entity == .event { eventStatus = statusAfterRequest } else { reminderStatus = statusAfterRequest }
        return statusAfterRequest
    }

    func refresh(_ entity: CalendarEntity) { refreshes += 1 }

    func calendars(_ entity: CalendarEntity) throws(BridgeError) -> [CalendarRecord] {
        entity == .event ? calendars : lists
    }

    func events(start: Date, end: Date, calendarIds: [String]?) throws(BridgeError) -> [EventRecord] {
        lastEventQuery = (start, end, calendarIds)
        return events.filter { event in
            event.start < end && event.end > start && (calendarIds?.contains(event.calendarId) ?? true)
        }
    }

    /// Like EKEventStore.event(withIdentifier:): the first occurrence.
    func event(id: String) throws(BridgeError) -> EventRecord? {
        events.filter { $0.id == id }.min { $0.occurrenceDate < $1.occurrenceDate }
    }

    func createEvent(_ draft: EventDraft) throws(BridgeError) -> SavedItem {
        createdEvents.append(draft)
        return SavedItem(id: "new-event", lastModified: savedAt)
    }

    func updateEvent(_ event: EventRecord, changes: EventChanges) throws(BridgeError) -> SavedItem {
        updates.append((event, changes))
        return SavedItem(id: event.id, lastModified: savedAt)
    }

    func reminders(listIds: [String]?, includeCompleted: Bool) throws(BridgeError) -> [ReminderRecord] {
        // Deliberately ignores includeCompleted so the service's own filter is exercised.
        reminders.filter { listIds?.contains($0.listId) ?? true }
    }

    func reminder(id: String) throws(BridgeError) -> ReminderRecord? { reminders.first { $0.id == id } }

    func createReminder(_ draft: ReminderDraft) throws(BridgeError) -> String {
        createdReminders.append(draft)
        return "new-reminder"
    }

    func setCompleted(_ reminder: ReminderRecord, completed: Bool) throws(BridgeError) {
        completions.append((reminder.id, completed))
    }
}

/// The whole desktop in memory: window server, capture, Accessibility, event posting and input
/// state. Nothing here calls a real TCC-protected API or posts a real event.
final class FakeDesktop: WindowServerBackend, WindowCaptureBackend, AccessibilityBackend, InputBackend, UserActivityBackend {
    /// Front to back.
    var windows: [WindowInfo] = []
    var apps: [Int32: AppInfo] = [:]
    var screenRecording = true
    var screenRecordingAfterRequest = false
    var screenRecordingRequests = 0
    var trusted = true
    var trustAfterRequest = false
    var trustRequests = 0
    /// nil: the owner of the front-most layer-0 window has focus, on that window.
    var focusOverride: FocusedWindow?
    var raiseSucceeds = true
    /// When raising succeeds, also move the window to the front (as the OS normally does).
    var raiseMovesToFront = true
    var raised: [UInt32] = []
    var secureInput = false
    var locked = false
    var clock: TimeInterval = 1000
    var lastHIDEvent: TimeInterval = 990
    /// Posted events reach the HID state, like real events posted at the HID tap.
    var postsUpdateHID = true
    var sleeps: [TimeInterval] = []
    var posted: [InputUnit] = []
    /// Called after each post with the number of units posted so far.
    var onPost: ((Int) -> Void)?
    /// Called after the clock advanced for a sleep.
    var onSleep: ((TimeInterval) -> Void)?
    var captures: [(UInt32, Int)] = []
    var captureResult: Result<CapturedImage, BridgeError> = .success(
        CapturedImage(png: Data([0x89, 0x50, 0x4E, 0x47]), width: 1600, height: 1200))

    var backends: DesktopBackends {
        DesktopBackends(windows: self, capture: self, accessibility: self, input: self, activity: self)
    }

    /// Adds a window behind the existing ones (and its app, if new).
    @discardableResult
    func addWindow(
        _ id: UInt32, pid: Int32, bundleId: String? = nil, name: String = "App", regular: Bool = true, layer: Int = 0,
        bounds: CGRect = CGRect(x: 100, y: 200, width: 800, height: 600), title: String? = "Title", alpha: Double = 1
    ) -> WindowInfo {
        let window = WindowInfo(windowId: id, pid: pid, layer: layer, bounds: bounds, title: title, alpha: alpha)
        windows.append(window)
        if apps[pid] == nil { apps[pid] = AppInfo(bundleId: bundleId ?? "com.example.app\(pid)", name: name, regular: regular) }
        return window
    }

    /// Moves a window to the front of its layer (never above windows of a higher layer).
    func moveToFront(_ id: UInt32) {
        guard let index = windows.firstIndex(where: { $0.windowId == id }) else { return }
        let window = windows.remove(at: index)
        windows.insert(window, at: windows.firstIndex(where: { $0.layer <= window.layer }) ?? windows.endIndex)
    }

    // WindowServerBackend
    func onScreenWindows() -> [WindowInfo] { windows }
    func app(pid: Int32) -> AppInfo? { apps[pid] }
    func screenRecordingGranted() -> Bool { screenRecording }
    func requestScreenRecording() -> Bool {
        screenRecordingRequests += 1
        screenRecording = screenRecordingAfterRequest
        return screenRecording
    }

    // WindowCaptureBackend
    func capture(windowId: UInt32, maxPixelWidth: Int) throws(BridgeError) -> CapturedImage {
        captures.append((windowId, maxPixelWidth))
        return try captureResult.get()
    }

    // AccessibilityBackend
    func isTrusted() -> Bool { trusted }
    func requestTrust() -> Bool {
        trustRequests += 1
        trusted = trustAfterRequest
        return trusted
    }
    func bringToFront(_ window: WindowInfo) -> Bool {
        raised.append(window.windowId)
        if raiseSucceeds && raiseMovesToFront { moveToFront(window.windowId) }
        return raiseSucceeds
    }
    func focusedWindow(among candidates: [WindowInfo]) -> FocusedWindow? {
        if let focusOverride { return focusOverride }
        return candidates.first { $0.layer == 0 && $0.alpha > 0 }.map { FocusedWindow(pid: $0.pid, windowId: $0.windowId) }
    }

    // InputBackend
    func post(_ unit: InputUnit) throws(BridgeError) {
        posted.append(unit)
        if postsUpdateHID { lastHIDEvent = clock }
        onPost?(posted.count)
    }

    // UserActivityBackend
    func secureInputEnabled() -> Bool { secureInput }
    func screenLocked() -> Bool { locked }
    func secondsSinceLastInput() -> TimeInterval { clock - lastHIDEvent }
    func uptime() -> TimeInterval { clock }
    func sleep(_ seconds: TimeInterval) {
        sleeps.append(seconds)
        clock += seconds
        onSleep?(seconds)
    }
}

/// Records every handler call; never compiles or runs AppleScript.
final class FakeAutomation: AutomationBackend {
    var calls: [(AutomationHandler, [ScriptValue])] = []
    var responses: [AutomationHandler: Result<ScriptValue, BridgeError>] = [:]

    func call(_ handler: AutomationHandler, _ args: [ScriptValue]) throws(BridgeError) -> ScriptValue {
        calls.append((handler, args))
        guard let response = responses[handler] else { throw BridgeError(.io, "no fake response") }
        return try response.get()
    }
}
