import Foundation
import XCTest

@testable import BridgeCore

/// Contacts/Calendar/Reminders methods driven through Session with in-memory backends.
/// Nothing here touches the real Contacts or EventKit stores or any request API.
final class PIMTests: XCTestCase {
    var sandbox: Sandbox!
    var contacts: FakeContacts!
    var calendar: FakeCalendar!
    var session: Session!

    static let base: Int64 = 1_800_000_000_000  // 2027-01-15T08:00:00Z
    static let hour: Int64 = 3_600_000
    static let day: Int64 = 86_400_000

    override func setUpWithError() throws {
        sandbox = try Sandbox()
        contacts = FakeContacts()
        calendar = FakeCalendar()
        calendar.calendars = [
            CalendarRecord(id: "work", title: "Work", account: "iCloud", sourceType: "caldav", writable: true),
            CalendarRecord(id: "holidays", title: "Holidays", account: "Other", sourceType: "subscribed", writable: false),
            CalendarRecord(id: "home", title: "Home", account: "iCloud", sourceType: "caldav", writable: true),
        ]
        calendar.lists = [
            CalendarRecord(id: "todo", title: "To Do", account: "iCloud", sourceType: "caldav", writable: true),
            CalendarRecord(id: "shared", title: "Shared", account: "iCloud", sourceType: "caldav", writable: false),
        ]
        session = fakeSession(config: sandbox.config, contacts: contacts, calendar: calendar)
        let hello: JSONValue = ["type": "hello", "nonce": "00112233445566778899aabbccddeeff", "protocol": 1]
        _ = session.handle(frame: try hello.encoded())
    }

    // MARK: - Helpers

    private func call(_ method: String, _ params: JSONValue = [:]) throws -> JSONValue {
        let request: JSONValue = ["id": "r1", "method": .string(method), "params": params]
        guard case .reply(let data) = session.handle(frame: try request.encoded()) else {
            XCTFail("expected a reply")
            return .null
        }
        return try JSONValue.parse(data)
    }

    private func result(_ method: String, _ params: JSONValue = [:], file: StaticString = #filePath, line: UInt = #line)
        throws -> JSONValue
    {
        let response = try call(method, params)
        XCTAssertEqual(response["ok"], true, "\(response)", file: file, line: line)
        return response["result"] ?? .null
    }

    private func assertError(
        _ code: String, _ method: String, _ params: JSONValue = [:], message: String? = nil,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let response = try call(method, params)
        XCTAssertEqual(response["ok"], false, file: file, line: line)
        XCTAssertEqual(response["error"]?["code"], .string(code), "\(response)", file: file, line: line)
        if let message { XCTAssertEqual(response["error"]?["message"], .string(message), file: file, line: line) }
    }

    private func date(_ ms: Int64) -> Date { PIMService.date(ms) }

    private func array(_ value: JSONValue?) -> [JSONValue] {
        if case .array(let items)? = value { return items }
        XCTFail("not an array: \(String(describing: value))")
        return []
    }

    private func keys(_ value: JSONValue) -> Set<String> {
        if case .object(let dict) = value { return Set(dict.keys) }
        return []
    }

    private func event(
        _ id: String, _ calendarId: String = "work", start: Int64, hours: Int64 = 1, recurring: Bool = false,
        lastModified: Int64? = nil, writable: Bool = true
    ) -> EventRecord {
        EventRecord(
            id: id, calendarId: calendarId, calendarWritable: writable, title: "Event \(id)", start: date(start),
            end: date(start + hours * Self.hour), allDay: false, recurring: recurring,
            lastModified: lastModified.map(date))
    }

    private func updateParams(
        _ id: String, occurrence: JSONValue = nil, expected: JSONValue = nil, changes: JSONValue = ["title": "New"]
    ) -> JSONValue {
        ["id": .string(id), "occurrenceDate": occurrence, "expectedLastModified": expected, "changes": changes]
    }

    // MARK: - Permissions

    func testPermissionGatingNeverPrompts() throws {
        contacts.currentStatus = .denied
        try assertError("permission", "contacts.search", ["query": "Ann"], message: "contacts: denied")
        XCTAssertEqual(contacts.searches, [])

        calendar.eventStatus = .writeOnly
        try assertError("permission", "calendar.calendars", message: "calendars: write-only")
        try assertError("permission", "calendar.events", ["start": .int(Self.base), "end": .int(Self.base + Self.day)])
        try assertError("permission", "calendar.createEvent", [
            "calendarId": "work", "title": "x", "start": .int(Self.base), "end": .int(Self.base + Self.hour), "allDay": false,
        ])
        try assertError("permission", "calendar.updateEvent", updateParams("e1"))

        calendar.reminderStatus = .notRequested
        try assertError("permission", "reminders.lists", message: "reminders: not-requested")
        try assertError("permission", "reminders.list")
        try assertError("permission", "reminders.create", ["listId": "todo", "title": "x"])
        try assertError("permission", "reminders.complete", ["id": "r", "completed": true])
        calendar.reminderStatus = .restricted
        try assertError("permission", "reminders.list", message: "reminders: restricted")

        XCTAssertTrue(contacts.requestTimeouts.isEmpty)
        XCTAssertTrue(calendar.requests.isEmpty)
        XCTAssertTrue(calendar.createdEvents.isEmpty && calendar.updates.isEmpty && calendar.createdReminders.isEmpty)
        XCTAssertEqual(calendar.refreshes, 0)

        contacts.currentStatus = .limited
        XCTAssertEqual(try result("contacts.search", ["query": "Ann"])["contacts"], [])
    }

    func testPermissionsRequestOnlyPromptsWhenUndetermined() throws {
        contacts.currentStatus = .notRequested
        contacts.statusAfterRequest = .denied
        XCTAssertEqual(try result("permissions.request", ["kind": "contacts"]), ["status": "denied"])
        XCTAssertEqual(contacts.requestTimeouts, [180])

        // Already determined: returned as-is, no second request.
        XCTAssertEqual(try result("permissions.request", ["kind": "contacts"]), ["status": "denied"])
        XCTAssertEqual(contacts.requestTimeouts.count, 1)

        calendar.eventStatus = .notRequested
        calendar.statusAfterRequest = .granted
        XCTAssertEqual(try result("permissions.request", ["kind": "calendars"]), ["status": "granted"])
        calendar.reminderStatus = .writeOnly
        XCTAssertEqual(try result("permissions.request", ["kind": "reminders"]), ["status": "write-only"])
        XCTAssertEqual(calendar.requests.count, 1)
        XCTAssertEqual(calendar.requests.first?.0, .event)
        XCTAssertEqual(calendar.requests.first?.1, 180)

        try assertError("invalid_params", "permissions.request", ["kind": "camera"])
        try assertError("invalid_params", "permissions.request")
        try assertError("invalid_params", "permissions.request", ["kind": "contacts", "force": true])
        XCTAssertEqual(contacts.requestTimeouts.count, 1)
    }

    func testVersionBumped() throws {
        XCTAssertEqual(try result("status")["version"], "0.3.0")
    }

    // MARK: - Contacts

    func testContactsSearchMergesDedupesSortsAndLimits() throws {
        let zoe = ContactRecord(id: "z", givenName: "Zoe", familyName: "Adams",
                                phones: [LabeledValue(label: "mobile", value: "+1 555 0100")])
        let amy = ContactRecord(id: "a", givenName: "Amy", middleName: "B", familyName: "Cole",
                                emails: [LabeledValue(label: nil, value: "amy@example.com")])
        let acme = ContactRecord(id: "o", organization: "Acme")
        contacts.byName["555 0100"] = [zoe]
        contacts.byPhone["555 0100"] = [zoe, amy, acme]

        let found = array(try result("contacts.search", ["query": "  555 0100 "])["contacts"])
        XCTAssertEqual(contacts.searches, ["name", "phone"])
        XCTAssertEqual(found.map { $0["id"] }, ["o", "a", "z"])
        XCTAssertEqual(found.map { $0["name"] }, ["Acme", "Amy B Cole", "Zoe Adams"])
        XCTAssertEqual(found[0]["organization"], "Acme")
        XCTAssertEqual(found[1]["organization"], .null)
        XCTAssertEqual(found[1]["emails"], [["label": nil, "value": "amy@example.com"]])
        XCTAssertEqual(found[2]["phones"], [["label": "mobile", "value": "+1 555 0100"]])
        for contact in found { XCTAssertEqual(keys(contact), ["id", "name", "organization", "phones", "emails"]) }

        let limited = array(try result("contacts.search", ["query": "555 0100", "limit": 2])["contacts"])
        XCTAssertEqual(limited.map { $0["id"] }, ["o", "a"])
    }

    func testContactsSearchPicksPredicatesByQueryShape() throws {
        let amy = ContactRecord(id: "a", givenName: "Amy")
        contacts.byName["amy@example.com"] = [amy]
        contacts.byEmail["amy@example.com"] = [amy]
        XCTAssertEqual(array(try result("contacts.search", ["query": "amy@example.com"])["contacts"]).count, 1)
        XCTAssertEqual(contacts.searches, ["name", "email"])

        contacts.searches = []
        _ = try result("contacts.search", ["query": "Amy"])
        _ = try result("contacts.search", ["query": "R2-D2"])
        XCTAssertEqual(contacts.searches, ["name", "name"])

        let fallback = ContactRecord(id: "n", nickname: "Ace")
        contacts.byName["Ace"] = [fallback]
        XCTAssertEqual(array(try result("contacts.search", ["query": "Ace"])["contacts"]).first?["name"], "Ace")
    }

    func testContactsFetchOnlyMinimalKeys() {
        XCTAssertEqual(Set(ContactsStoreBackend.keysToFetch), [
            "identifier", "givenName", "middleName", "familyName", "nickname", "organizationName", "phoneNumbers",
            "emailAddresses",
        ])
    }

    func testContactsSearchValidation() throws {
        try assertError("invalid_params", "contacts.search", ["query": "   "])
        try assertError("invalid_params", "contacts.search", ["query": .string(String(repeating: "a", count: 201))])
        try assertError("invalid_params", "contacts.search", ["query": "a", "limit": 0])
        try assertError("invalid_params", "contacts.search", ["query": "a", "limit": 51])
        try assertError("invalid_params", "contacts.search", ["query": "a", "limit": nil])
        try assertError("invalid_params", "contacts.search", ["query": 5])
        XCTAssertEqual(contacts.searches, [])
        _ = try result("contacts.search", ["query": .string(String(repeating: "a", count: 200)), "limit": 50])
    }

    // MARK: - Calendar

    func testCalendarsListing() throws {
        let calendars = array(try result("calendar.calendars")["calendars"])
        XCTAssertEqual(calendars.map { $0["id"] }, ["home", "work", "holidays"])
        XCTAssertEqual(calendars[2], [
            "id": "holidays", "title": "Holidays", "account": "Other", "sourceType": "subscribed", "writable": false,
        ])
        XCTAssertEqual(calendar.refreshes, 1)
    }

    func testEventRangeValidation() throws {
        let start = Self.base
        try assertError("invalid_params", "calendar.events", ["start": .int(start), "end": .int(start)])
        try assertError("invalid_params", "calendar.events", ["start": .int(start), "end": .int(start - 1)])
        try assertError("invalid_params", "calendar.events", ["start": .int(start), "end": .int(start + 366 * Self.day + 1)])
        try assertError("invalid_params", "calendar.events", ["start": .int(start), "end": .double(1.5)])
        try assertError("invalid_params", "calendar.events", ["start": .int(start)])
        try assertError("invalid_params", "calendar.events", ["start": .int(start), "end": .int(start + 1), "limit": 501])
        try assertError("invalid_params", "calendar.events", ["start": .int(start), "end": .int(start + 1), "calendarIds": []])
        try assertError("invalid_params", "calendar.events", ["start": .int(start), "end": .int(start + 1), "calendarIds": [1]])
        try assertError("invalid_params", "calendar.events", ["start": -9_000_000_000_000, "end": .int(start)])
        XCTAssertNil(calendar.lastEventQuery)
        _ = try result("calendar.events", ["start": .int(start), "end": .int(start + 366 * Self.day)])
    }

    func testEventsUnknownCalendarIsNotFound() throws {
        try assertError("not_found", "calendar.events", [
            "start": .int(Self.base), "end": .int(Self.base + Self.day), "calendarIds": ["work", "nope"],
        ])
        XCTAssertNil(calendar.lastEventQuery)
    }

    func testEventsSortedTruncatedAndMinimal() throws {
        calendar.events = [
            event("late", start: Self.base + 5 * Self.hour),
            event("early", "home", start: Self.base + Self.hour, lastModified: Self.base - Self.day),
            event("mid", start: Self.base + 3 * Self.hour, recurring: true),
            event("outside", start: Self.base + 3 * Self.day),
        ]
        calendar.events[0].location = "Room 1"
        calendar.events[0].url = "https://example.com/m"

        let all = try result("calendar.events", ["start": .int(Self.base), "end": .int(Self.base + Self.day), "calendarIds": nil])
        let events = array(all["events"])
        XCTAssertEqual(events.map { $0["id"] }, ["early", "mid", "late"])
        XCTAssertEqual(all["truncated"], false)
        XCTAssertEqual(events[0], [
            "id": "early", "calendarId": "home", "title": "Event early", "start": .int(Self.base + Self.hour),
            "end": .int(Self.base + 2 * Self.hour), "allDay": false, "location": nil, "url": nil, "recurring": false,
            "occurrenceDate": .int(Self.base + Self.hour), "lastModified": .int(Self.base - Self.day),
        ])
        XCTAssertEqual(events[1]["recurring"], true)
        XCTAssertEqual(events[2]["location"], "Room 1")
        XCTAssertEqual(events[2]["url"], "https://example.com/m")

        let page = try result("calendar.events", ["start": .int(Self.base), "end": .int(Self.base + Self.day), "limit": 2])
        XCTAssertEqual(array(page["events"]).map { $0["id"] }, ["early", "mid"])
        XCTAssertEqual(page["truncated"], true)

        let work = try result("calendar.events", [
            "start": .int(Self.base), "end": .int(Self.base + Self.day), "calendarIds": ["work", "work"],
        ])
        XCTAssertEqual(array(work["events"]).map { $0["id"] }, ["mid", "late"])
        XCTAssertEqual(calendar.lastEventQuery?.2, ["work"])
    }

    func testCreateEvent() throws {
        let params: JSONValue = [
            "calendarId": "work", "title": "Lunch", "start": .int(Self.base), "end": .int(Self.base + Self.hour),
            "allDay": false, "location": "Cafe", "notes": nil, "timeZone": "Europe/Paris",
        ]
        let created = try result("calendar.createEvent", params)
        XCTAssertEqual(created, ["id": "new-event", "lastModified": 1_800_000_000_123])
        XCTAssertEqual(calendar.createdEvents, [EventDraft(
            calendarId: "work", title: "Lunch", start: date(Self.base), end: date(Self.base + Self.hour), allDay: false,
            location: "Cafe", notes: nil, timeZone: TimeZone(identifier: "Europe/Paris"))])

        // Optional keys may be omitted.
        _ = try result("calendar.createEvent", [
            "calendarId": "home", "title": "Day off", "start": .int(Self.base), "end": .int(Self.base + Self.day),
            "allDay": true,
        ])
        XCTAssertEqual(calendar.createdEvents.count, 2)
    }

    func testCreateEventErrors() throws {
        var params: [String: JSONValue] = [
            "calendarId": "holidays", "title": "x", "start": .int(Self.base), "end": .int(Self.base + Self.hour),
            "allDay": false,
        ]
        try assertError("read_only", "calendar.createEvent", .object(params))
        params["calendarId"] = "missing"
        try assertError("not_found", "calendar.createEvent", .object(params))
        params["calendarId"] = "work"
        params["timeZone"] = "Mars/Olympus"
        try assertError("invalid_params", "calendar.createEvent", .object(params))
        params["timeZone"] = nil
        params["end"] = .int(Self.base)
        try assertError("invalid_params", "calendar.createEvent", .object(params))
        params["end"] = .int(Self.base + 1)
        params["title"] = " "
        try assertError("invalid_params", "calendar.createEvent", .object(params))
        params["title"] = "x"
        params["allDay"] = nil
        try assertError("invalid_params", "calendar.createEvent", .object(params))
        params["allDay"] = 0
        try assertError("invalid_params", "calendar.createEvent", .object(params))
        params["allDay"] = false
        params["attendees"] = ["a@example.com"]
        try assertError("invalid_params", "calendar.createEvent", .object(params))
        XCTAssertTrue(calendar.createdEvents.isEmpty)
    }

    func testUpdateConflictOnLastModified() throws {
        calendar.events = [event("e1", start: Self.base, lastModified: Self.base - Self.hour)]
        try assertError("conflict", "calendar.updateEvent", updateParams("e1", expected: .int(Self.base - Self.hour + 1)))
        XCTAssertTrue(calendar.updates.isEmpty)

        let updated = try result("calendar.updateEvent", updateParams("e1", expected: .int(Self.base - Self.hour)))
        XCTAssertEqual(updated, ["id": "e1", "lastModified": 1_800_000_000_123])
        _ = try result("calendar.updateEvent", updateParams("e1", expected: nil))
        XCTAssertEqual(calendar.updates.count, 2)

        // An event that has never reported a modification date cannot satisfy a non-null expectation.
        calendar.events = [event("e2", start: Self.base)]
        try assertError("conflict", "calendar.updateEvent", updateParams("e2", expected: .int(Self.base)))
    }

    func testUpdateRecurringPicksOccurrence() throws {
        let occurrences = (0..<3).map { index in
            event("series", start: Self.base + Int64(index) * 7 * Self.day, recurring: true,
                  lastModified: Self.base - Self.day + Int64(index))
        }
        calendar.events = occurrences + [event("other", start: Self.base + 7 * Self.day)]
        let second = Self.base + 7 * Self.day

        _ = try result("calendar.updateEvent", updateParams(
            "series", occurrence: .int(second), expected: .int(Self.base - Self.day + 1),
            changes: ["start": .int(second + Self.hour), "end": .int(second + 2 * Self.hour)]))
        XCTAssertEqual(calendar.updates.count, 1)
        XCTAssertEqual(calendar.updates[0].0.occurrenceDate, date(second))
        XCTAssertEqual(calendar.updates[0].1.start, date(second + Self.hour))
        XCTAssertEqual(calendar.lastEventQuery?.0, date(second - Self.day))
        XCTAssertEqual(calendar.lastEventQuery?.1, date(second + Self.day))
        XCTAssertEqual(calendar.lastEventQuery?.2, ["work"])

        // The lastModified precondition applies to the selected occurrence, not the first one.
        try assertError("conflict", "calendar.updateEvent", updateParams(
            "series", occurrence: .int(second), expected: .int(Self.base - Self.day)))
        try assertError("not_found", "calendar.updateEvent", updateParams("series", occurrence: .int(second + Self.hour)))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("series"))
        try assertError("not_found", "calendar.updateEvent", updateParams("missing"))
        XCTAssertEqual(calendar.updates.count, 1)
    }

    func testUpdateChangesValidation() throws {
        calendar.events = [event("e1", start: Self.base), event("ro", "holidays", start: Self.base, writable: false)]
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: [:]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["color": "red"]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["title": nil]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["allDay": nil]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["start": "soon"]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: "title"))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["end": .int(Self.base)]))
        try assertError("invalid_params", "calendar.updateEvent", ["id": "e1", "occurrenceDate": nil, "changes": ["title": "x"]])
        try assertError("invalid_params", "calendar.updateEvent", ["id": "e1", "expectedLastModified": nil, "changes": ["title": "x"]])
        try assertError("invalid_params", "calendar.updateEvent", ["id": "e1", "occurrenceDate": nil, "expectedLastModified": nil])
        try assertError("read_only", "calendar.updateEvent", updateParams("ro"))
        XCTAssertTrue(calendar.updates.isEmpty)

        _ = try result("calendar.updateEvent", updateParams("e1", changes: ["location": nil, "notes": "bring slides"]))
        XCTAssertEqual(calendar.updates.last?.1, EventChanges(location: .some(nil), notes: .some("bring slides")))
        _ = try result("calendar.updateEvent", updateParams("e1", changes: ["allDay": true]))
        XCTAssertEqual(calendar.updates.last?.1, EventChanges(allDay: true))
    }

    // MARK: - Reminders

    func testReminderLists() throws {
        let lists = array(try result("reminders.lists")["lists"])
        XCTAssertEqual(lists, [
            ["id": "shared", "title": "Shared", "account": "iCloud", "writable": false],
            ["id": "todo", "title": "To Do", "account": "iCloud", "writable": true],
        ])
    }

    func testRemindersSortingFilteringAndLimit() throws {
        calendar.reminders = [
            ReminderRecord(id: "undated", listId: "todo", listWritable: true, title: "Undated"),
            ReminderRecord(id: "done-old", listId: "todo", listWritable: true, title: "Old", completed: true,
                           completedAt: date(Self.base - 2 * Self.day)),
            ReminderRecord(id: "later", listId: "todo", listWritable: true, title: "Later", due: date(Self.base + Self.day),
                           priority: 1),
            ReminderRecord(id: "done-new", listId: "shared", listWritable: false, title: "New", completed: true,
                           completedAt: date(Self.base - Self.day)),
            ReminderRecord(id: "soon", listId: "shared", listWritable: false, title: "Soon", due: date(Self.base),
                           dueAllDay: true),
        ]
        let open = try result("reminders.list")
        XCTAssertEqual(array(open["reminders"]).map { $0["id"] }, ["soon", "later", "undated"])
        XCTAssertEqual(open["truncated"], false)
        XCTAssertEqual(array(open["reminders"])[0], [
            "id": "soon", "listId": "shared", "title": "Soon", "due": .int(Self.base), "dueAllDay": true,
            "completed": false, "completedAt": nil, "priority": 0,
        ])

        let all = try result("reminders.list", ["includeCompleted": true, "listIds": nil])
        XCTAssertEqual(array(all["reminders"]).map { $0["id"] }, ["soon", "later", "undated", "done-new", "done-old"])

        let page = try result("reminders.list", ["includeCompleted": true, "limit": 4])
        XCTAssertEqual(array(page["reminders"]).map { $0["id"] }, ["soon", "later", "undated", "done-new"])
        XCTAssertEqual(page["truncated"], true)

        let todo = try result("reminders.list", ["listIds": ["todo"], "includeCompleted": true])
        XCTAssertEqual(array(todo["reminders"]).map { $0["id"] }, ["later", "undated", "done-old"])

        try assertError("not_found", "reminders.list", ["listIds": ["nope"]])
        try assertError("invalid_params", "reminders.list", ["limit": 0])
        try assertError("invalid_params", "reminders.list", ["includeCompleted": "yes"])
    }

    func testCreateReminder() throws {
        XCTAssertEqual(try result("reminders.create", ["listId": "todo", "title": "Milk"]), ["id": "new-reminder"])
        _ = try result("reminders.create", [
            "listId": "todo", "title": "Call", "due": .int(Self.base), "dueAllDay": true, "notes": "about R2",
        ])
        XCTAssertEqual(calendar.createdReminders, [
            ReminderDraft(listId: "todo", title: "Milk", due: nil, dueAllDay: false, notes: nil),
            ReminderDraft(listId: "todo", title: "Call", due: date(Self.base), dueAllDay: true, notes: "about R2"),
        ])
        try assertError("read_only", "reminders.create", ["listId": "shared", "title": "x"])
        try assertError("not_found", "reminders.create", ["listId": "nope", "title": "x"])
        try assertError("invalid_params", "reminders.create", ["listId": "todo", "title": "x", "dueAllDay": true])
        try assertError("invalid_params", "reminders.create", ["listId": "todo", "title": "x", "priority": 1])
        XCTAssertEqual(calendar.createdReminders.count, 2)
    }

    func testCompleteReminder() throws {
        calendar.reminders = [
            ReminderRecord(id: "r1", listId: "todo", listWritable: true, title: "A"),
            ReminderRecord(id: "r2", listId: "shared", listWritable: false, title: "B"),
        ]
        XCTAssertEqual(try result("reminders.complete", ["id": "r1", "completed": true]), ["id": "r1", "completed": true])
        XCTAssertEqual(calendar.completions.map(\.0), ["r1"])
        // Already in the requested state: nothing is saved.
        _ = try result("reminders.complete", ["id": "r1", "completed": false])
        XCTAssertEqual(calendar.completions.count, 1)
        try assertError("read_only", "reminders.complete", ["id": "r2", "completed": true])
        try assertError("not_found", "reminders.complete", ["id": "r3", "completed": true])
        try assertError("invalid_params", "reminders.complete", ["id": "r1"])
        try assertError("invalid_params", "reminders.complete", ["id": "", "completed": true])
    }

    // MARK: - Strictness

    func testUnknownParamsRejectedEverywhere() throws {
        let calls: [(String, [String: JSONValue])] = [
            ("permissions.request", ["kind": "contacts"]),
            ("contacts.search", ["query": "Ann"]),
            ("calendar.calendars", [:]),
            ("calendar.events", ["start": .int(Self.base), "end": .int(Self.base + 1)]),
            ("calendar.createEvent", ["calendarId": "work", "title": "x", "start": .int(Self.base),
                                      "end": .int(Self.base + 1), "allDay": false]),
            ("calendar.updateEvent", ["id": "e", "occurrenceDate": nil, "expectedLastModified": nil, "changes": ["title": "x"]]),
            ("reminders.lists", [:]),
            ("reminders.list", [:]),
            ("reminders.create", ["listId": "todo", "title": "x"]),
            ("reminders.complete", ["id": "r", "completed": true]),
        ]
        for (method, params) in calls {
            var extra = params
            extra["includeNotes"] = true
            try assertError("invalid_params", method, .object(extra))
            try assertError("invalid_params", method, "not an object")
        }
        XCTAssertTrue(contacts.searches.isEmpty && contacts.requestTimeouts.isEmpty && calendar.requests.isEmpty)
        XCTAssertEqual(calendar.refreshes, 0)
    }

    func testMaxLengths() throws {
        let over: (Int) -> JSONValue = { .string(String(repeating: "é", count: $0 / 2) + String(repeating: "a", count: $0 % 2 + 1)) }
        let event: [String: JSONValue] = [
            "calendarId": "work", "title": "x", "start": .int(Self.base), "end": .int(Self.base + 1), "allDay": false,
        ]
        func with(_ base: [String: JSONValue], _ key: String, _ value: JSONValue) -> JSONValue {
            var copy = base
            copy[key] = value
            return .object(copy)
        }
        // Limits are UTF-8 bytes: "é" is two bytes.
        try assertError("invalid_params", "contacts.search", ["query": over(200)])
        try assertError("invalid_params", "calendar.createEvent", with(event, "title", over(500)))
        try assertError("invalid_params", "calendar.createEvent", with(event, "location", over(500)))
        try assertError("invalid_params", "calendar.createEvent", with(event, "notes", over(8000)))
        try assertError("invalid_params", "calendar.createEvent", with(event, "calendarId", over(512)))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["title": over(500)]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["location": over(500)]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams("e1", changes: ["notes": over(8000)]))
        try assertError("invalid_params", "calendar.updateEvent", updateParams(String(repeating: "i", count: 513)))
        try assertError("invalid_params", "calendar.events", [
            "start": .int(Self.base), "end": .int(Self.base + 1), "calendarIds": [over(512)],
        ])
        try assertError("invalid_params", "reminders.create", ["listId": "todo", "title": over(500)])
        try assertError("invalid_params", "reminders.create", ["listId": "todo", "title": "x", "notes": over(8000)])
        try assertError("invalid_params", "reminders.complete", ["id": over(512), "completed": true])
        try assertError("invalid_params", "reminders.list", ["listIds": [over(512)]])
        XCTAssertTrue(calendar.createdEvents.isEmpty && calendar.createdReminders.isEmpty && contacts.searches.isEmpty)

        // Exactly at the limits is accepted.
        var exact = event
        exact["title"] = .string(String(repeating: "é", count: 250))
        exact["location"] = .string(String(repeating: "a", count: 500))
        exact["notes"] = .string(String(repeating: "a", count: 8000))
        _ = try result("calendar.createEvent", .object(exact))
    }

    func testRealBackendsAreLazyAndUntouchedByValidation() throws {
        // Default backends: invalid params never reach Contacts/EventKit, so this is safe without TCC grants.
        let real = Session(config: sandbox.config)
        let hello: JSONValue = ["type": "hello", "nonce": "00112233445566778899aabbccddeeff", "protocol": 1]
        _ = real.handle(frame: try hello.encoded())
        let request: JSONValue = ["id": "1", "method": "calendar.events", "params": ["start": 1, "end": 0]]
        guard case .reply(let data) = real.handle(frame: try request.encoded()) else { return XCTFail() }
        XCTAssertEqual(try JSONValue.parse(data)["error"]?["code"], "invalid_params")
    }

    // MARK: - Callback bridging used by permissions.request and reminders.list

    func testWaiterBridgesBackgroundCallbacksAndTimesOut() {
        let waiter = Waiter<Bool>()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { waiter.fulfill(true) }
        XCTAssertEqual(waiter.wait(timeout: 5), true)

        let slow = Waiter<Bool>()
        let started = Date()
        XCTAssertNil(slow.wait(timeout: 0.1))
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        // A callback that arrives after the timeout (or twice) is ignored without crashing.
        slow.fulfill(true)
        slow.fulfill(false)
    }
}
