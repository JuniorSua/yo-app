import Foundation

// Narrow seams over Contacts and EventKit. The real implementations (ContactsStoreBackend,
// EventKitBackend) do framework calls only; validation, permission gating, sorting, limits,
// conflict detection and error mapping live in PIMService so they can be tested with fakes.

public struct LabeledValue: Equatable, Sendable {
    public var label: String?
    public var value: String

    public init(label: String?, value: String) {
        self.label = label
        self.value = value
    }
}

/// The only contact fields the helper ever fetches. Notes and images are deliberately absent.
public struct ContactRecord: Equatable, Sendable {
    public var id: String
    public var givenName = ""
    public var middleName = ""
    public var familyName = ""
    public var nickname = ""
    public var organization = ""
    public var phones: [LabeledValue] = []
    public var emails: [LabeledValue] = []

    public init(
        id: String, givenName: String = "", middleName: String = "", familyName: String = "", nickname: String = "",
        organization: String = "", phones: [LabeledValue] = [], emails: [LabeledValue] = []
    ) {
        self.id = id
        self.givenName = givenName
        self.middleName = middleName
        self.familyName = familyName
        self.nickname = nickname
        self.organization = organization
        self.phones = phones
        self.emails = emails
    }

    /// "Given Middle Family", else the nickname, else the organization.
    public var displayName: String {
        let full = [givenName, middleName, familyName].filter { !$0.isEmpty }.joined(separator: " ")
        if !full.isEmpty { return full }
        return nickname.isEmpty ? organization : nickname
    }
}

public protocol ContactsBackend: AnyObject {
    /// Non-prompting.
    func status() -> AccessStatus
    /// May show the OS prompt. Only `permissions.request` calls this.
    func requestAccess(timeout: TimeInterval) -> AccessStatus
    func search(name: String) throws(BridgeError) -> [ContactRecord]
    func search(phone: String) throws(BridgeError) -> [ContactRecord]
    func search(email: String) throws(BridgeError) -> [ContactRecord]
}

public enum CalendarEntity: Sendable {
    case event, reminder

    var permissionName: String { self == .event ? "calendars" : "reminders" }
}

public struct CalendarRecord: Equatable, Sendable {
    public var id: String
    public var title: String
    public var account: String
    public var sourceType: String
    public var writable: Bool

    public init(id: String, title: String, account: String, sourceType: String, writable: Bool) {
        self.id = id
        self.title = title
        self.account = account
        self.sourceType = sourceType
        self.writable = writable
    }
}

public struct EventRecord {
    public var id: String
    public var calendarId: String
    public var calendarWritable: Bool
    public var title: String
    public var start: Date
    public var end: Date
    public var allDay: Bool
    public var location: String?
    public var url: String?
    public var recurring: Bool
    public var occurrenceDate: Date
    public var lastModified: Date?
    /// Backend-private native object (EKEvent) so an update edits exactly the occurrence that was selected.
    public var handle: AnyObject?

    public init(
        id: String, calendarId: String, calendarWritable: Bool, title: String, start: Date, end: Date, allDay: Bool,
        location: String? = nil, url: String? = nil, recurring: Bool = false, occurrenceDate: Date? = nil,
        lastModified: Date? = nil, handle: AnyObject? = nil
    ) {
        self.id = id
        self.calendarId = calendarId
        self.calendarWritable = calendarWritable
        self.title = title
        self.start = start
        self.end = end
        self.allDay = allDay
        self.location = location
        self.url = url
        self.recurring = recurring
        self.occurrenceDate = occurrenceDate ?? start
        self.lastModified = lastModified
        self.handle = handle
    }
}

public struct EventDraft: Equatable {
    public var calendarId: String
    public var title: String
    public var start: Date
    public var end: Date
    public var allDay: Bool
    public var location: String?
    public var notes: String?
    public var timeZone: TimeZone?
}

/// Absent fields are left unchanged. `location`/`notes` use `.some(nil)` to clear.
public struct EventChanges: Equatable {
    public var title: String?
    public var start: Date?
    public var end: Date?
    public var allDay: Bool?
    public var location: String??
    public var notes: String??

    public var isEmpty: Bool {
        title == nil && start == nil && end == nil && allDay == nil && location == nil && notes == nil
    }
}

public struct SavedItem: Equatable {
    public var id: String
    public var lastModified: Date?

    public init(id: String, lastModified: Date?) {
        self.id = id
        self.lastModified = lastModified
    }
}

public struct ReminderRecord {
    public var id: String
    public var listId: String
    public var listWritable: Bool
    public var title: String
    public var due: Date?
    public var dueAllDay: Bool
    public var completed: Bool
    public var completedAt: Date?
    public var priority: Int
    public var handle: AnyObject?

    public init(
        id: String, listId: String, listWritable: Bool, title: String, due: Date? = nil, dueAllDay: Bool = false,
        completed: Bool = false, completedAt: Date? = nil, priority: Int = 0, handle: AnyObject? = nil
    ) {
        self.id = id
        self.listId = listId
        self.listWritable = listWritable
        self.title = title
        self.due = due
        self.dueAllDay = dueAllDay
        self.completed = completed
        self.completedAt = completedAt
        self.priority = priority
        self.handle = handle
    }
}

public struct ReminderDraft: Equatable {
    public var listId: String
    public var title: String
    public var due: Date?
    public var dueAllDay: Bool
    public var notes: String?
}

public protocol CalendarBackend: AnyObject {
    /// Non-prompting.
    func status(_ entity: CalendarEntity) -> AccessStatus
    /// May show the OS prompt. Only `permissions.request` calls this.
    func requestAccess(_ entity: CalendarEntity, timeout: TimeInterval) -> AccessStatus
    /// Called once per request (after the permission check) so cached objects are not stale.
    func refresh(_ entity: CalendarEntity)
    func calendars(_ entity: CalendarEntity) throws(BridgeError) -> [CalendarRecord]
    /// Every occurrence overlapping [start, end) in the given calendars (nil = all event calendars).
    func events(start: Date, end: Date, calendarIds: [String]?) throws(BridgeError) -> [EventRecord]
    /// The event (first occurrence of a recurring series) with this eventIdentifier.
    func event(id: String) throws(BridgeError) -> EventRecord?
    func createEvent(_ draft: EventDraft) throws(BridgeError) -> SavedItem
    func updateEvent(_ event: EventRecord, changes: EventChanges) throws(BridgeError) -> SavedItem
    func reminders(listIds: [String]?, includeCompleted: Bool) throws(BridgeError) -> [ReminderRecord]
    func reminder(id: String) throws(BridgeError) -> ReminderRecord?
    func createReminder(_ draft: ReminderDraft) throws(BridgeError) -> String
    func setCompleted(_ reminder: ReminderRecord, completed: Bool) throws(BridgeError)
}

/// Bridges a callback-based API to the synchronous session. Safe if the callback fires late or twice.
final class Waiter<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var value: Value?

    func fulfill(_ newValue: Value) {
        lock.lock()
        guard value == nil else { return lock.unlock() }
        value = newValue
        lock.unlock()
        semaphore.signal()
    }

    /// nil on timeout.
    func wait(timeout: TimeInterval) -> Value? {
        guard semaphore.wait(timeout: .now() + timeout) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

/// Carries a non-Sendable framework object into a background closure that is known to be the only user.
struct UncheckedBox<Value>: @unchecked Sendable {
    let value: Value
}
