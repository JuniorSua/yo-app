import Foundation

/// Contacts, Calendar and Reminders methods: parameter validation, permission gating, sorting,
/// limits and preconditions. Framework access goes through the injected backends.
final class PIMService {
    enum Limit {
        static let titleBytes = 500
        static let locationBytes = 500
        static let notesBytes = 8000
        static let queryBytes = 200
        static let idBytes = 512
        static let idCount = 100
        static let timeZoneBytes = 100
        /// Timestamps must fall in [1900-01-01, 2200-01-01) UTC.
        static let minMs: Int64 = -2_208_988_800_000
        static let maxMs: Int64 = 7_258_118_400_000
        static let maxEventSpanMs: Int64 = 366 * 86_400_000
    }

    static let requestTimeout: TimeInterval = 180
    private static let dayMs: Int64 = 86_400_000

    private let contacts: ContactsBackend
    private let calendar: CalendarBackend

    init(contacts: ContactsBackend, calendar: CalendarBackend) {
        self.contacts = contacts
        self.calendar = calendar
    }

    // MARK: - permissions.request

    /// nil for a kind this service does not own.
    func requestPermission(kind: String) -> AccessStatus? {
        switch kind {
        case "contacts":
            let current = contacts.status()
            return current == .notRequested ? contacts.requestAccess(timeout: Self.requestTimeout) : current
        case "calendars", "reminders":
            let entity: CalendarEntity = kind == "calendars" ? .event : .reminder
            let current = calendar.status(entity)
            return current == .notRequested ? calendar.requestAccess(entity, timeout: Self.requestTimeout) : current
        default:
            return nil
        }
    }

    // MARK: - Contacts

    func searchContacts(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let raw = try params.string("query", maxBytes: Limit.queryBytes)
        let limit = try params.int("limit", default: 20)
        try params.finish()
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { throw BridgeError.invalidParams("query must not be empty") }
        guard (1...50).contains(limit) else { throw BridgeError.invalidParams("limit must be 1...50") }

        let status = contacts.status()
        guard status == .granted || status == .limited else { throw Self.permission("contacts", status) }

        var found = try contacts.search(name: query)
        if Self.looksLikePhone(query) { found += try contacts.search(phone: query) }
        if Self.looksLikeEmail(query) { found += try contacts.search(email: query) }

        var seen = Set<String>()
        let unique = found.filter { seen.insert($0.id).inserted }
        let sorted = unique.sorted { a, b in
            let order = a.displayName.localizedStandardCompare(b.displayName)
            return order == .orderedSame ? a.id < b.id : order == .orderedAscending
        }
        return ["contacts": .array(sorted.prefix(limit).map(Self.json))]
    }

    static func looksLikePhone(_ query: String) -> Bool {
        let allowed = Set("0123456789+-(). ")
        return query.allSatisfy(allowed.contains) && query.filter(\.isNumber).count >= 3
    }

    static func looksLikeEmail(_ query: String) -> Bool {
        query.contains("@") && query.count >= 3 && !query.contains(where: \.isWhitespace)
    }

    private static func json(_ contact: ContactRecord) -> JSONValue {
        let labeled: (LabeledValue) -> JSONValue = { ["label": $0.label.map(JSONValue.string) ?? .null, "value": .string($0.value)] }
        return [
            "id": .string(contact.id),
            "name": .string(contact.displayName),
            "organization": contact.organization.isEmpty ? .null : .string(contact.organization),
            "phones": .array(contact.phones.map(labeled)),
            "emails": .array(contact.emails.map(labeled)),
        ]
    }

    // MARK: - Calendar

    func listCalendars(_ params: inout Params) throws(BridgeError) -> JSONValue {
        try params.finish()
        try requireFullAccess(.event)
        let calendars = try calendar.calendars(.event).sorted(by: Self.calendarOrder)
        return [
            "calendars": .array(calendars.map {
                [
                    "id": .string($0.id), "title": .string($0.title), "account": .string($0.account),
                    "sourceType": .string($0.sourceType), "writable": .bool($0.writable),
                ]
            })
        ]
    }

    func listEvents(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let start = try Self.timestamp(&params, "start")
        let end = try Self.timestamp(&params, "end")
        let calendarIds = try params.optionalStringArray("calendarIds", maxCount: Limit.idCount, maxBytes: Limit.idBytes)
        let limit = try params.int("limit", default: 200)
        try params.finish()
        guard end > start else { throw BridgeError.invalidParams("end must be after start") }
        guard end - start <= Limit.maxEventSpanMs else { throw BridgeError.invalidParams("range exceeds 366 days") }
        guard (1...500).contains(limit) else { throw BridgeError.invalidParams("limit must be 1...500") }

        try requireFullAccess(.event)
        if let calendarIds {
            let known = Set(try calendar.calendars(.event).map(\.id))
            guard calendarIds.allSatisfy(known.contains) else { throw BridgeError(.notFound, "unknown calendar") }
        }
        let events = try calendar.events(start: Self.date(start), end: Self.date(end), calendarIds: calendarIds)
            .sorted(by: Self.eventOrder)
        return [
            "events": .array(events.prefix(limit).map(Self.json)),
            "truncated": .bool(events.count > limit),
        ]
    }

    func createEvent(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let calendarId = try Self.id(&params, "calendarId")
        let title = try Self.title(&params)
        let start = try Self.timestamp(&params, "start")
        let end = try Self.timestamp(&params, "end")
        let allDay = try params.bool("allDay")
        let location = try params.optionalString("location", maxBytes: Limit.locationBytes)
        let notes = try params.optionalString("notes", maxBytes: Limit.notesBytes)
        let zoneName = try params.optionalString("timeZone", maxBytes: Limit.timeZoneBytes)
        try params.finish()
        guard end > start else { throw BridgeError.invalidParams("end must be after start") }
        var timeZone: TimeZone?
        if let zoneName {
            guard let zone = TimeZone(identifier: zoneName) else { throw BridgeError.invalidParams("unknown timeZone") }
            timeZone = zone
        }

        try requireFullAccess(.event)
        guard let target = try calendar.calendars(.event).first(where: { $0.id == calendarId }) else {
            throw BridgeError(.notFound, "unknown calendar")
        }
        guard target.writable else { throw BridgeError(.readOnly, "calendar does not allow modifications") }
        let saved = try calendar.createEvent(EventDraft(
            calendarId: calendarId, title: title, start: Self.date(start), end: Self.date(end), allDay: allDay,
            location: location, notes: notes, timeZone: timeZone))
        return Self.json(saved)
    }

    func updateEvent(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let id = try Self.id(&params, "id")
        let occurrence = try Self.optionalTimestamp(&params, "occurrenceDate")
        let expected = try Self.optionalTimestamp(&params, "expectedLastModified")
        var raw = try params.object("changes")
        try params.finish()

        var changes = EventChanges()
        if let value = try raw.presentValue("title") {
            guard case .string(let title) = value else { throw BridgeError.invalidParams("title must be a string") }
            changes.title = try Self.checkedTitle(title)
        }
        if let value = try raw.presentValue("start") { changes.start = Self.date(try Self.timestamp(value, "start")) }
        if let value = try raw.presentValue("end") { changes.end = Self.date(try Self.timestamp(value, "end")) }
        if let value = try raw.presentValue("allDay") {
            guard case .bool(let allDay) = value else { throw BridgeError.invalidParams("allDay must be a boolean") }
            changes.allDay = allDay
        }
        changes.location = try raw.nullableStringIfPresent("location", maxBytes: Limit.locationBytes)
        changes.notes = try raw.nullableStringIfPresent("notes", maxBytes: Limit.notesBytes)
        try raw.finish()
        guard !changes.isEmpty else { throw BridgeError.invalidParams("changes must not be empty") }

        try requireFullAccess(.event)
        guard var target = try calendar.event(id: id) else { throw BridgeError(.notFound, "event not found") }
        if let occurrence {
            // Recurring events share one eventIdentifier; the occurrence date picks the instance.
            let window = try calendar.events(
                start: Self.date(occurrence - Self.dayMs), end: Self.date(occurrence + Self.dayMs),
                calendarIds: [target.calendarId])
            guard let match = window.first(where: { $0.id == id && Self.ms($0.occurrenceDate) == occurrence }) else {
                throw BridgeError(.notFound, "occurrence not found")
            }
            target = match
        } else if target.recurring {
            throw BridgeError.invalidParams("occurrenceDate is required for recurring events")
        }
        if let expected, target.lastModified.map(Self.ms) != expected {
            throw BridgeError(.conflict, "event changed since it was read")
        }
        guard target.calendarWritable else { throw BridgeError(.readOnly, "calendar does not allow modifications") }
        guard (changes.end ?? target.end) > (changes.start ?? target.start) else {
            throw BridgeError.invalidParams("end must be after start")
        }
        return Self.json(try calendar.updateEvent(target, changes: changes))
    }

    // MARK: - Reminders

    func listReminderLists(_ params: inout Params) throws(BridgeError) -> JSONValue {
        try params.finish()
        try requireFullAccess(.reminder)
        let lists = try calendar.calendars(.reminder).sorted(by: Self.calendarOrder)
        return [
            "lists": .array(lists.map {
                ["id": .string($0.id), "title": .string($0.title), "account": .string($0.account), "writable": .bool($0.writable)]
            })
        ]
    }

    func listReminders(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let listIds = try params.optionalStringArray("listIds", maxCount: Limit.idCount, maxBytes: Limit.idBytes)
        let includeCompleted = try params.bool("includeCompleted", default: false)
        let limit = try params.int("limit", default: 200)
        try params.finish()
        guard (1...500).contains(limit) else { throw BridgeError.invalidParams("limit must be 1...500") }

        try requireFullAccess(.reminder)
        if let listIds {
            let known = Set(try calendar.calendars(.reminder).map(\.id))
            guard listIds.allSatisfy(known.contains) else { throw BridgeError(.notFound, "unknown reminder list") }
        }
        let reminders = try calendar.reminders(listIds: listIds, includeCompleted: includeCompleted)
            .filter { includeCompleted || !$0.completed }
            .sorted(by: Self.reminderOrder)
        return [
            "reminders": .array(reminders.prefix(limit).map {
                [
                    "id": .string($0.id), "listId": .string($0.listId), "title": .string($0.title),
                    "due": Self.msOrNull($0.due), "dueAllDay": .bool($0.dueAllDay), "completed": .bool($0.completed),
                    "completedAt": Self.msOrNull($0.completedAt), "priority": .int(Int64($0.priority)),
                ]
            }),
            "truncated": .bool(reminders.count > limit),
        ]
    }

    func createReminder(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let listId = try Self.id(&params, "listId")
        let title = try Self.title(&params)
        let due = try Self.optionalTimestamp(&params, "due", required: false)
        let dueAllDay = try params.bool("dueAllDay", default: false)
        let notes = try params.optionalString("notes", maxBytes: Limit.notesBytes)
        try params.finish()
        if dueAllDay && due == nil { throw BridgeError.invalidParams("dueAllDay requires due") }

        try requireFullAccess(.reminder)
        guard let list = try calendar.calendars(.reminder).first(where: { $0.id == listId }) else {
            throw BridgeError(.notFound, "unknown reminder list")
        }
        guard list.writable else { throw BridgeError(.readOnly, "list does not allow modifications") }
        let id = try calendar.createReminder(ReminderDraft(
            listId: listId, title: title, due: due.map(Self.date), dueAllDay: dueAllDay, notes: notes))
        return ["id": .string(id)]
    }

    func completeReminder(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let id = try Self.id(&params, "id")
        let completed = try params.bool("completed")
        try params.finish()

        try requireFullAccess(.reminder)
        guard let reminder = try calendar.reminder(id: id) else { throw BridgeError(.notFound, "reminder not found") }
        guard reminder.listWritable else { throw BridgeError(.readOnly, "list does not allow modifications") }
        if reminder.completed != completed { try calendar.setCompleted(reminder, completed: completed) }
        return ["id": .string(id), "completed": .bool(completed)]
    }

    // MARK: - Helpers

    private func requireFullAccess(_ entity: CalendarEntity) throws(BridgeError) {
        let status = calendar.status(entity)
        guard status == .granted else { throw Self.permission(entity.permissionName, status) }
        calendar.refresh(entity)
    }

    static func permission(_ name: String, _ status: AccessStatus) -> BridgeError {
        BridgeError(.permission, "\(name): \(status.rawValue)")
    }

    private static func id(_ params: inout Params, _ key: String) throws(BridgeError) -> String {
        let value = try params.string(key, maxBytes: Limit.idBytes)
        guard !value.isEmpty else { throw BridgeError.invalidParams("\(key) must not be empty") }
        return value
    }

    private static func title(_ params: inout Params) throws(BridgeError) -> String {
        try checkedTitle(try params.string("title", maxBytes: Limit.titleBytes))
    }

    private static func checkedTitle(_ title: String) throws(BridgeError) -> String {
        guard title.utf8.count <= Limit.titleBytes else { throw BridgeError.invalidParams("title is too long") }
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeError.invalidParams("title must not be empty")
        }
        return title
    }

    private static func timestamp(_ params: inout Params, _ key: String) throws(BridgeError) -> Int64 {
        try checkedMs(try params.int64(key), key)
    }

    /// Integer or null; the key is required unless `required` is false.
    private static func optionalTimestamp(_ params: inout Params, _ key: String, required: Bool = true)
        throws(BridgeError) -> Int64?
    {
        guard let value = try params.optionalInt64(key, required: required) else { return nil }
        return try checkedMs(value, key)
    }

    private static func timestamp(_ value: JSONValue, _ key: String) throws(BridgeError) -> Int64 {
        guard case .int(let ms) = value else { throw BridgeError.invalidParams("\(key) must be an integer") }
        return try checkedMs(ms, key)
    }

    private static func checkedMs(_ ms: Int64, _ key: String) throws(BridgeError) -> Int64 {
        guard ms >= Limit.minMs, ms < Limit.maxMs else { throw BridgeError.invalidParams("\(key) is out of range") }
        return ms
    }

    static func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

    static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }

    private static func msOrNull(_ date: Date?) -> JSONValue { date.map { .int(ms($0)) } ?? .null }

    private static func json(_ saved: SavedItem) -> JSONValue {
        ["id": .string(saved.id), "lastModified": msOrNull(saved.lastModified)]
    }

    private static func json(_ event: EventRecord) -> JSONValue {
        [
            "id": .string(event.id), "calendarId": .string(event.calendarId), "title": .string(event.title),
            "start": .int(ms(event.start)), "end": .int(ms(event.end)), "allDay": .bool(event.allDay),
            "location": event.location.map(JSONValue.string) ?? .null, "url": event.url.map(JSONValue.string) ?? .null,
            "recurring": .bool(event.recurring), "occurrenceDate": .int(ms(event.occurrenceDate)),
            "lastModified": msOrNull(event.lastModified),
        ]
    }

    /// By account, then title (localized, case-insensitive), then id for a stable order.
    private static func calendarOrder(_ a: CalendarRecord, _ b: CalendarRecord) -> Bool {
        for (x, y) in [(a.account, b.account), (a.title, b.title)] {
            let order = x.localizedStandardCompare(y)
            if order != .orderedSame { return order == .orderedAscending }
        }
        return a.id < b.id
    }

    private static func eventOrder(_ a: EventRecord, _ b: EventRecord) -> Bool {
        (a.start, a.end, a.id, a.occurrenceDate) < (b.start, b.end, b.id, b.occurrenceDate)
    }

    /// Incomplete first (by due, undated last), then completed (most recently completed first, undated last).
    static func reminderOrder(_ a: ReminderRecord, _ b: ReminderRecord) -> Bool {
        if a.completed != b.completed { return !a.completed }
        if a.completed, a.completedAt != b.completedAt { return nilLast(a.completedAt, b.completedAt, by: >) }
        if !a.completed, a.due != b.due { return nilLast(a.due, b.due, by: <) }
        return (a.title, a.id) < (b.title, b.id)
    }

    private static func nilLast(_ a: Date?, _ b: Date?, by order: (Date, Date) -> Bool) -> Bool {
        switch (a, b) {
        case (let a?, let b?): return order(a, b)
        case (nil, _): return false
        case (_, nil): return true
        }
    }
}
