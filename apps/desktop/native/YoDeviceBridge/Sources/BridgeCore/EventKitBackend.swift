import EventKit
import Foundation

/// Calendar and Reminders access through one long-lived EKEventStore.
/// No attendees, alarms or recurrence rules are ever written; saves use span `.thisEvent`.
public final class EventKitBackend: CalendarBackend {
    private static let fetchTimeout: TimeInterval = 30

    private var storage: EKEventStore?
    /// Entities that had full access when `storage` was created. A store created before access was
    /// granted (for example in System Settings while the helper runs) is replaced once.
    private var storageAccess: Set<EKEntityType> = []

    public init() {}

    /// Created on first use; constructing a store never prompts.
    private var store: EKEventStore {
        if let storage { return storage }
        let created = EKEventStore()
        storage = created
        storageAccess = Set([EKEntityType.event, .reminder].filter { EKEventStore.authorizationStatus(for: $0) == .fullAccess })
        return created
    }

    public func status(_ entity: CalendarEntity) -> AccessStatus { Permissions.eventKit(Self.type(entity)) }

    public func requestAccess(_ entity: CalendarEntity, timeout: TimeInterval) -> AccessStatus {
        let waiter = Waiter<Bool>()
        let box = UncheckedBox(value: store)
        // The prompt's callback arrives on a framework queue; the session thread just waits.
        DispatchQueue.global(qos: .userInitiated).async {
            let done: @Sendable (Bool, (any Error)?) -> Void = { granted, _ in waiter.fulfill(granted) }
            switch entity {
            case .event: box.value.requestFullAccessToEvents(completion: done)
            case .reminder: box.value.requestFullAccessToReminders(completion: done)
            }
        }
        _ = waiter.wait(timeout: timeout)
        return status(entity)
    }

    public func refresh(_ entity: CalendarEntity) {
        guard let storage else { return }
        if storageAccess.contains(Self.type(entity)) {
            // Drop cached objects so lastModified checks and listings see other apps' changes.
            storage.reset()
        } else {
            self.storage = nil
        }
    }

    public func calendars(_ entity: CalendarEntity) throws(BridgeError) -> [CalendarRecord] {
        store.calendars(for: Self.type(entity)).map {
            CalendarRecord(
                id: $0.calendarIdentifier, title: $0.title, account: $0.source?.title ?? "",
                sourceType: Self.sourceType($0.source?.sourceType), writable: $0.allowsContentModifications)
        }
    }

    public func events(start: Date, end: Date, calendarIds: [String]?) throws(BridgeError) -> [EventRecord] {
        var calendars: [EKCalendar]?
        if let calendarIds {
            calendars = store.calendars(for: .event).filter { calendarIds.contains($0.calendarIdentifier) }
            if calendars?.isEmpty == true { return [] }
        }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
        return store.events(matching: predicate).compactMap(Self.record)
    }

    public func event(id: String) throws(BridgeError) -> EventRecord? {
        store.event(withIdentifier: id).flatMap(Self.record)
    }

    public func createEvent(_ draft: EventDraft) throws(BridgeError) -> SavedItem {
        let calendar = try writableCalendar(draft.calendarId, .event)
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = draft.title
        // All-day events are floating; otherwise set the zone before the instants it applies to.
        event.isAllDay = draft.allDay
        if !draft.allDay, let zone = draft.timeZone { event.timeZone = zone }
        event.startDate = draft.start
        event.endDate = draft.end
        event.location = draft.location
        event.notes = draft.notes
        try save { try store.save(event, span: .thisEvent, commit: true) }
        _ = event.refresh()
        guard let id = event.eventIdentifier else { throw BridgeError(.io, "saved event has no identifier") }
        return SavedItem(id: id, lastModified: event.lastModifiedDate)
    }

    public func updateEvent(_ record: EventRecord, changes: EventChanges) throws(BridgeError) -> SavedItem {
        guard let event = record.handle as? EKEvent else { throw BridgeError(.io, "event handle unavailable") }
        if let title = changes.title { event.title = title }
        if let allDay = changes.allDay { event.isAllDay = allDay }
        if let start = changes.start { event.startDate = start }
        if let end = changes.end { event.endDate = end }
        if let location = changes.location { event.location = location }
        if let notes = changes.notes { event.notes = notes }
        // Never .futureEvents: an update edits exactly one occurrence.
        try save { try store.save(event, span: .thisEvent, commit: true) }
        _ = event.refresh()
        return SavedItem(id: event.eventIdentifier ?? record.id, lastModified: event.lastModifiedDate)
    }

    public func reminders(listIds: [String]?, includeCompleted: Bool) throws(BridgeError) -> [ReminderRecord] {
        var calendars: [EKCalendar]?
        if let listIds {
            calendars = store.calendars(for: .reminder).filter { listIds.contains($0.calendarIdentifier) }
            if calendars?.isEmpty == true { return [] }
        }
        let predicate = includeCompleted
            ? store.predicateForReminders(in: calendars)
            : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
        let waiter = Waiter<UncheckedBox<[EKReminder]>>()
        let request = store.fetchReminders(matching: predicate) { waiter.fulfill(UncheckedBox(value: $0 ?? [])) }
        guard let fetched = waiter.wait(timeout: Self.fetchTimeout) else {
            store.cancelFetchRequest(request)
            throw BridgeError(.io, "reminders fetch timed out")
        }
        return fetched.value.compactMap(Self.record)
    }

    public func reminder(id: String) throws(BridgeError) -> ReminderRecord? {
        (store.calendarItem(withIdentifier: id) as? EKReminder).flatMap(Self.record)
    }

    public func createReminder(_ draft: ReminderDraft) throws(BridgeError) -> String {
        let list = try writableCalendar(draft.listId, .reminder)
        let reminder = EKReminder(eventStore: store)
        reminder.calendar = list
        reminder.title = draft.title
        reminder.notes = draft.notes
        if let due = draft.due {
            let calendar = Calendar.current
            if draft.dueAllDay {
                reminder.dueDateComponents = calendar.dateComponents([.year, .month, .day], from: due)
            } else {
                var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: due)
                components.timeZone = calendar.timeZone
                reminder.dueDateComponents = components
            }
        }
        try save { try store.save(reminder, commit: true) }
        return reminder.calendarItemIdentifier
    }

    public func setCompleted(_ record: ReminderRecord, completed: Bool) throws(BridgeError) {
        guard let reminder = record.handle as? EKReminder else { throw BridgeError(.io, "reminder handle unavailable") }
        reminder.isCompleted = completed
        try save { try store.save(reminder, commit: true) }
    }

    // MARK: - Helpers

    private func writableCalendar(_ id: String, _ entity: CalendarEntity) throws(BridgeError) -> EKCalendar {
        guard let calendar = store.calendar(withIdentifier: id),
            calendar.allowedEntityTypes.contains(entity == .event ? .event : .reminder)
        else { throw BridgeError(.notFound, entity == .event ? "unknown calendar" : "unknown reminder list") }
        guard calendar.allowsContentModifications else {
            throw BridgeError(.readOnly, entity == .event ? "calendar does not allow modifications" : "list does not allow modifications")
        }
        return calendar
    }

    private func save(_ body: () throws -> Void) throws(BridgeError) {
        do {
            try body()
        } catch let error as EKError {
            switch error.code {
            case .calendarReadOnly, .eventNotMutable, .calendarDoesNotAllowEvents, .calendarDoesNotAllowReminders,
                .calendarIsImmutable, .sourceDoesNotAllowCalendarAddDelete:
                throw BridgeError(.readOnly, "the calendar rejected the change")
            case .datesInverted, .noStartDate, .noEndDate, .startDateTooFarInFuture, .durationGreaterThanRecurrence,
                .startDateCollidesWithOtherOccurrence, .invalidSpan:
                throw BridgeError.invalidParams("the calendar rejected the dates")
            case .eventStoreNotAuthorized:
                throw BridgeError(.permission, "calendar access not granted")
            default:
                throw BridgeError(.io, "save failed")
            }
        } catch {
            throw BridgeError(.io, "save failed")
        }
    }

    private static func type(_ entity: CalendarEntity) -> EKEntityType { entity == .event ? .event : .reminder }

    private static func sourceType(_ type: EKSourceType?) -> String {
        switch type {
        case .local?: return "local"
        case .exchange?: return "exchange"
        case .calDAV?: return "caldav"
        case .mobileMe?: return "mobileme"
        case .subscribed?: return "subscribed"
        case .birthdays?: return "birthdays"
        default: return "unknown"
        }
    }

    private static func record(_ event: EKEvent) -> EventRecord? {
        guard let id = event.eventIdentifier, let start = event.startDate, let end = event.endDate else { return nil }
        return EventRecord(
            id: id, calendarId: event.calendar?.calendarIdentifier ?? "",
            calendarWritable: event.calendar?.allowsContentModifications ?? false, title: event.title ?? "",
            start: start, end: end, allDay: event.isAllDay, location: event.location.flatMap { $0.isEmpty ? nil : $0 },
            url: event.url?.absoluteString, recurring: event.hasRecurrenceRules, occurrenceDate: event.occurrenceDate ?? start,
            lastModified: event.lastModifiedDate, handle: event)
    }

    private static func record(_ reminder: EKReminder) -> ReminderRecord? {
        let components = reminder.dueDateComponents
        let due = components.flatMap { ($0.calendar ?? Calendar.current).date(from: $0) }
        return ReminderRecord(
            id: reminder.calendarItemIdentifier, listId: reminder.calendar?.calendarIdentifier ?? "",
            listWritable: reminder.calendar?.allowsContentModifications ?? false, title: reminder.title ?? "",
            due: due, dueAllDay: due != nil && components?.hour == nil, completed: reminder.isCompleted,
            completedAt: reminder.completionDate, priority: reminder.priority, handle: reminder)
    }
}
