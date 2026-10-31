import Foundation
import XCTest

@testable import BridgeCore

/// Notes and Mail methods driven through Session with FakeAutomation. No test compiles or runs
/// AppleScript or sends an Apple Event (the template compile check is opt-in, see the last test).
final class AutomationTests: XCTestCase {
    var sandbox: Sandbox!
    var automation: FakeAutomation!
    var session: Session!

    static let base = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        sandbox = try Sandbox()
        automation = FakeAutomation()
        session = try greeted(fakeSession(config: sandbox.config, automation: automation))
    }

    // MARK: - Helpers

    private func call(_ method: String, _ params: JSONValue = [:]) throws -> JSONValue {
        let request: JSONValue = ["id": "a1", "method": .string(method), "params": params]
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
        XCTAssertEqual(response["ok"], false, "\(response)", file: file, line: line)
        XCTAssertEqual(response["error"]?["code"], .string(code), "\(response)", file: file, line: line)
        if let message { XCTAssertEqual(response["error"]?["message"], .string(message), file: file, line: line) }
    }

    private func array(_ value: JSONValue?) -> [JSONValue] {
        if case .array(let items)? = value { return items }
        XCTFail("not an array: \(String(describing: value))")
        return []
    }

    private func date(_ offset: TimeInterval) -> ScriptValue { .date(Self.base.addingTimeInterval(offset)) }

    private func ms(_ offset: TimeInterval) -> JSONValue { .int(Int64((Self.base.timeIntervalSince1970 + offset) * 1000)) }

    private func strings(_ items: [String]) -> ScriptValue { .list(items.map(ScriptValue.string)) }

    /// notes_search result: {ids, names, dates, locked, bodyMatchIds}.
    private func notesIndex(_ notes: [(id: String, name: String, age: TimeInterval?, locked: Bool)], bodyMatches: [String])
        -> ScriptValue
    {
        .list([
            strings(notes.map(\.id)), strings(notes.map(\.name)),
            .list(notes.map { $0.age.map { date(-$0) } ?? .null }), .list(notes.map { .bool($0.locked) }), strings(bodyMatches),
        ])
    }

    // MARK: - notes.search

    func testNotesSearchMatchesSortsAndLimits() throws {
        automation.responses[.notesSearch] = .success(notesIndex([
            (id: "n1", name: "Groceries", age: 300, locked: false),
            (id: "n2", name: "Café plans", age: 100, locked: false),
            (id: "n3", name: "Diary", age: 50, locked: true),
            (id: "n4", name: "Trip", age: 10, locked: false),
            (id: "n5", name: "CAFE receipts", age: nil, locked: false),
            (id: "n6", name: "Work", age: 500, locked: false),
        ], bodyMatches: ["n3", "n4"]))
        automation.responses[.notesFolders] = .success(strings(["Travel", "Notes", "Archive"]))

        let notes = array(try result("notes.search", ["query": " cafe ", "limit": 3])["notes"])
        // n4 by body (newest), n2 by name (diacritic- and case-insensitive), n5 by name (no date: last).
        // n3 matches only by body but is locked, so it is skipped.
        XCTAssertEqual(notes, [
            ["id": "n4", "name": "Trip", "folder": "Travel", "modified": ms(-10)],
            ["id": "n2", "name": "Café plans", "folder": "Notes", "modified": ms(-100)],
            ["id": "n5", "name": "CAFE receipts", "folder": "Archive", "modified": nil],
        ])
        XCTAssertEqual(automation.calls.map(\.0), [.notesSearch, .notesFolders])
        XCTAssertEqual(automation.calls[0].1, [.string("cafe")])
        XCTAssertEqual(automation.calls[1].1, [strings(["n4", "n2", "n5"])])

        automation.calls = []
        automation.responses[.notesFolders] = .success(strings(["Travel"]))
        XCTAssertEqual(array(try result("notes.search", ["query": "cafe", "limit": 1])["notes"]).count, 1)
        XCTAssertEqual(automation.calls[1].1, [strings(["n4"])])
    }

    func testNotesSearchScansOnlyTheMostRecent2000() throws {
        var notes: [(id: String, name: String, age: TimeInterval?, locked: Bool)] = []
        for i in 0..<2100 { notes.append((id: "n\(i)", name: i >= 2000 ? "match old" : "other", age: TimeInterval(i), locked: false)) }
        notes.append((id: "recent", name: "match new", age: 0.5, locked: false))
        automation.responses[.notesSearch] = .success(notesIndex(notes, bodyMatches: ["n2099"]))
        automation.responses[.notesFolders] = .success(strings(["Notes"]))
        let found = array(try result("notes.search", ["query": "match", "limit": 50])["notes"])
        XCTAssertEqual(found.map { $0["id"] }, ["recent"])
    }

    func testNotesSearchNoMatchesSkipsFolderLookup() throws {
        automation.responses[.notesSearch] = .success(notesIndex([(id: "n1", name: "a", age: 1, locked: false)], bodyMatches: []))
        XCTAssertEqual(try result("notes.search", ["query": "zzz"]), ["notes": []])
        XCTAssertEqual(automation.calls.map(\.0), [.notesSearch])
    }

    func testNotesSearchRejectsInconsistentResults() throws {
        automation.responses[.notesSearch] = .success(.list([strings(["n1", "n2"]), strings(["a"]), .list([]), .list([]), .list([])]))
        try assertError("io", "notes.search", ["query": "a"], message: "notes changed during the search")
        automation.responses[.notesSearch] = .success(.list([strings(["n1"])]))
        try assertError("io", "notes.search", ["query": "a"], message: "unexpected automation result")
        automation.responses[.notesSearch] = .success(.string("nope"))
        try assertError("io", "notes.search", ["query": "a"])
        automation.responses[.notesSearch] = .success(notesIndex([(id: "n1", name: "a", age: 1, locked: false)], bodyMatches: []))
        automation.responses[.notesFolders] = .success(strings([]))
        try assertError("io", "notes.search", ["query": "a"])
    }

    func testNotesSearchValidation() throws {
        for bad: JSONValue in [
            [:], ["query": ""], ["query": "   "], ["query": .string(String(repeating: "a", count: 201))], ["query": 5],
            ["query": "a\nb"], ["query": "a", "limit": 0], ["query": "a", "limit": 51], ["query": "a", "limit": "5"],
            ["query": "a", "folder": "x"],
        ] {
            try assertError("invalid_params", "notes.search", bad)
        }
        XCTAssertTrue(automation.calls.isEmpty)
    }

    // MARK: - notes.read

    func testNotesRead() throws {
        let id = "x-coredata://1234-ABCD/ICNote/p42"
        let long = String(repeating: "é", count: 100_001)
        automation.responses[.notesRead] = .success(.list([.string(id), .string("Title"), .string("Notes"), date(-5), .bool(false), .string(long)]))
        let note = try result("notes.read", ["id": .string(id)])
        XCTAssertEqual(note["id"], .string(id))
        XCTAssertEqual(note["name"], "Title")
        XCTAssertEqual(note["folder"], "Notes")
        XCTAssertEqual(note["modified"], ms(-5))
        XCTAssertEqual(note["truncated"], true)
        if case .string(let text)? = note["text"] { XCTAssertEqual(text.count, 100_000) } else { XCTFail() }
        XCTAssertEqual(automation.calls.last?.1, [.string(id)])

        automation.responses[.notesRead] = .success(.list([.string(id), .string("T"), .null, .null, .bool(false), .string("short")]))
        let short = try result("notes.read", ["id": .string(id)])
        XCTAssertEqual(short["text"], "short")
        XCTAssertEqual(short["truncated"], false)
        XCTAssertEqual(short["folder"], "")
        XCTAssertEqual(short["modified"], .null)

        automation.responses[.notesRead] = .success(.list([.string(id), .string("T"), .string("F"), .null, .bool(true), .string("")]))
        try assertError("protected", "notes.read", ["id": .string(id)], message: "note is password protected")

        automation.responses[.notesRead] = .failure(AutomationService.mapError(-1728))
        try assertError("not_found", "notes.read", ["id": .string(id)])

        let calls = automation.calls.count
        for bad: JSONValue in [["id": "p42"], ["id": ""], ["id": "x-coredata://a b"], ["id": 5], [:],
                               ["id": .string("x-coredata://" + String(repeating: "a", count: 500))], ["id": .string(id), "html": true]] {
            try assertError("invalid_params", "notes.read", bad)
        }
        XCTAssertEqual(automation.calls.count, calls)
    }

    // MARK: - notes.create

    func testNotesCreateEscapesHTMLAndPassesParameters() throws {
        automation.responses[.notesCreate] = .success(.string("x-coredata://new/ICNote/p1"))
        let created = try result("notes.create", [
            "title": "<b>Tom & Jerry's \"plan\"</b>", "body": "line <1>\n\nline & 2\r\nend\t!", "folder": nil,
        ])
        XCTAssertEqual(created, ["id": "x-coredata://new/ICNote/p1"])
        XCTAssertEqual(automation.calls.last?.1, [
            .string(""),
            .string("<div><h1>&lt;b&gt;Tom &amp; Jerry&#39;s &quot;plan&quot;&lt;/b&gt;</h1></div>"
                + "<div>line &lt;1&gt;</div><div><br></div><div>line &amp; 2</div><div>end\t!</div>"),
        ])

        _ = try result("notes.create", ["title": "T", "body": "", "folder": "Work"])
        XCTAssertEqual(automation.calls.last?.1, [.string("Work"), .string("<div><h1>T</h1></div>")])
        _ = try result("notes.create", ["title": "T", "body": .string(String(repeating: "a", count: 50_000))])
        XCTAssertEqual(automation.calls.last?.1.first, .string(""))

        // A script-looking title is just text in an HTML parameter, never script source.
        _ = try result("notes.create", ["title": "\" & (do shell script \"id\") & \"", "body": "end tell"])
        XCTAssertEqual(automation.calls.last?.1[1],
                       .string("<div><h1>&quot; &amp; (do shell script &quot;id&quot;) &amp; &quot;</h1></div><div>end tell</div>"))

        automation.responses[.notesCreate] = .failure(AutomationService.mapError(-1728))
        try assertError("not_found", "notes.create", ["title": "T", "body": "", "folder": "Missing"])
    }

    func testNotesCreateValidation() throws {
        let calls = automation.calls.count
        for bad: JSONValue in [
            ["title": "", "body": ""], ["title": "  ", "body": ""], ["title": "a\nb", "body": ""], ["title": "T"],
            ["body": "x"], ["title": .string(String(repeating: "a", count: 501)), "body": ""],
            ["title": "T", "body": .string(String(repeating: "a", count: 50_001))], ["title": "T", "body": "bell\u{7}"],
            ["title": "T", "body": "", "folder": ""], ["title": "T", "body": "", "folder": " "], ["title": "T", "body": "", "folder": 3],
            ["title": "T", "body": "", "folder": .string(String(repeating: "f", count: 201))], ["title": "T", "body": "", "account": "x"],
            ["title": "T", "body": "", "folder": "a\nb"],
        ] {
            try assertError("invalid_params", "notes.create", bad)
        }
        XCTAssertEqual(automation.calls.count, calls)
    }

    // MARK: - mail.search

    private func mailbox(_ accountId: String, _ name: String, _ rows: [(Int64, String?, String?, TimeInterval?, Bool?)]) -> ScriptValue {
        .list([
            .string(accountId), .string(name), .list(rows.map { .int($0.0) }),
            .list(rows.map { $0.1.map(ScriptValue.string) ?? .null }), .list(rows.map { $0.2.map(ScriptValue.string) ?? .null }),
            .list(rows.map { $0.3.map { date(-$0) } ?? .null }), .list(rows.map { $0.4.map(ScriptValue.bool) ?? .null }),
        ])
    }

    func testMailSearchMatchesSubjectOrSenderAcrossAccounts() throws {
        automation.responses[.mailScan] = .success(.list([
            mailbox("ACCT-1", "iCloud", [
                (11, "Invoice March", "billing@shop.example", 60, false),
                (12, "Hello", "Ann <ann@example.com>", 30, true),
                (13, nil, nil, 10, nil),
            ]),
            mailbox("acct.2_x", "Work", [
                (21, "Re: invoice", "boss@work.example", 5, true),
                (22, "Lunch", "INVOICES <ap@work.example>", nil, false),
            ]),
            mailbox("bad id!", "Weird", [(31, "invoice", "x@y", 1, true)]),
        ]))
        let messages = array(try result("mail.search", ["query": "INVOICE", "limit": 10])["messages"])
        XCTAssertEqual(messages, [
            ["id": "inbox:acct.2_x:21", "subject": "Re: invoice", "sender": "boss@work.example", "date": ms(-5),
             "account": "Work", "mailbox": "inbox", "read": true],
            ["id": "inbox:ACCT-1:11", "subject": "Invoice March", "sender": "billing@shop.example", "date": ms(-60),
             "account": "iCloud", "mailbox": "inbox", "read": false],
            ["id": "inbox:acct.2_x:22", "subject": "Lunch", "sender": "INVOICES <ap@work.example>", "date": nil,
             "account": "Work", "mailbox": "inbox", "read": false],
        ])
        XCTAssertEqual(automation.calls.last?.1, [.string("inbox"), .int(500)])

        XCTAssertEqual(array(try result("mail.search", ["query": "ann@", "mailbox": "sent", "limit": 1])["messages"]).map { $0["id"] },
                       ["sent:ACCT-1:12"])
        XCTAssertEqual(automation.calls.last?.1, [.string("sent"), .int(500)])
        _ = try result("mail.search", ["query": "x", "mailbox": "drafts"])
        XCTAssertEqual(automation.calls.last?.1.first, .string("drafts"))
    }

    func testMailSearchValidationAndInconsistentResults() throws {
        for bad: JSONValue in [
            ["query": ""], ["query": "a", "mailbox": "trash"], ["query": "a", "mailbox": "INBOX"], ["query": "a", "mailbox": nil],
            ["query": "a", "limit": 51], ["query": "a", "account": "x"],
        ] {
            try assertError("invalid_params", "mail.search", bad)
        }
        XCTAssertTrue(automation.calls.isEmpty)
        automation.responses[.mailScan] = .success(.list([.list([.string("A"), .string("n"), .list([.int(1)]), .list([]), .list([]), .list([]), .list([])])]))
        try assertError("io", "mail.search", ["query": "a"], message: "mailbox changed during the search")
        automation.responses[.mailScan] = .success(.list([.list([.string("A")])]))
        try assertError("io", "mail.search", ["query": "a"])
    }

    // MARK: - mail.read

    func testMailRead() throws {
        automation.responses[.mailRead] = .success(.list([
            .int(48213), .string("Subject"), .string("Ann <ann@example.com>"), strings(["me@example.com", "you@example.com"]),
            strings([]), date(-1), .string(String(repeating: "x", count: 100_005)),
        ]))
        let message = try result("mail.read", ["id": "sent:6C1F-22AB:48213"])
        XCTAssertEqual(automation.calls.last?.1, [.string("sent"), .string("6C1F-22AB"), .int(48213)])
        XCTAssertEqual(message["id"], "sent:6C1F-22AB:48213")
        XCTAssertEqual(message["to"], ["me@example.com", "you@example.com"])
        XCTAssertEqual(message["cc"], [])
        XCTAssertEqual(message["date"], ms(-1))
        XCTAssertEqual(message["truncated"], true)
        XCTAssertEqual(message["sender"], "Ann <ann@example.com>")

        // Large Mail ids arrive as reals from AppleScript.
        automation.responses[.mailRead] = .success(.list([
            .double(3_000_000_000), .null, .null, strings([]), strings(["cc@example.com"]), .null, .null,
        ]))
        let other = try result("mail.read", ["id": "inbox::3000000000"])
        XCTAssertEqual(other["id"], "inbox::3000000000")
        XCTAssertEqual(other["subject"], "")
        XCTAssertEqual(other["content"], "")
        XCTAssertEqual(other["truncated"], false)
        XCTAssertEqual(automation.calls.last?.1, [.string("inbox"), .string(""), .int(3_000_000_000)])

        automation.responses[.mailRead] = .failure(AutomationService.mapError(-1728))
        try assertError("not_found", "mail.read", ["id": "inbox:A:1"])

        let calls = automation.calls.count
        for bad in ["inbox:A", "inbox:A:1:2", "trash:A:1", "inbox:a b:1", "inbox:A:-1", "inbox:A:0", "inbox:A:1x", "inbox:A:",
                    "inbox:A:9999999999999999999", "", "Inbox:A:1", "inbox:A/../B:1"] {
            try assertError("invalid_params", "mail.read", ["id": .string(bad)])
        }
        try assertError("invalid_params", "mail.read", ["id": 5])
        XCTAssertEqual(automation.calls.count, calls)
    }

    // MARK: - mail.createDraft

    func testMailCreateDraft() throws {
        automation.responses[.mailCreateDraft] = .success(.int(42))
        let draft = try result("mail.createDraft", [
            "to": ["ann@example.com", "bob@example.org"], "cc": ["cc@example.net"], "subject": "Plan", "body": "Hi,\n\nSee you.",
        ])
        XCTAssertEqual(draft, ["id": "outgoing:42"])
        XCTAssertEqual(automation.calls.last?.0, .mailCreateDraft)
        XCTAssertEqual(automation.calls.last?.1, [
            strings(["ann@example.com", "bob@example.org"]), strings(["cc@example.net"]), .string("Plan"), .string("Hi,\n\nSee you."),
        ])
        _ = try result("mail.createDraft", ["to": ["a@b"], "subject": "", "body": ""])
        XCTAssertEqual(automation.calls.last?.1[1], .list([]))
        let twenty: JSONValue = .array((0..<20).map { .string("p\($0)@example.com") })
        _ = try result("mail.createDraft", ["to": twenty, "cc": twenty, "subject": "s", "body": "b"])
    }

    func testMailCreateDraftValidation() throws {
        let long = String(repeating: "a", count: 310) + "@example.com"
        let twentyOne: JSONValue = .array((0..<21).map { .string("p\($0)@example.com") })
        for bad: JSONValue in [
            ["to": [], "subject": "", "body": ""], ["to": twentyOne, "subject": "", "body": ""],
            ["to": ["a@b"], "cc": twentyOne, "subject": "", "body": ""], ["to": ["a@b"], "cc": nil, "subject": "", "body": ""],
            ["to": ["ab"], "subject": "", "body": ""], ["to": ["a b@c"], "subject": "", "body": ""],
            ["to": ["a@b,c@d"], "subject": "", "body": ""], ["to": ["a@b;c@d"], "subject": "", "body": ""],
            ["to": ["Ann <a@b>"], "subject": "", "body": ""], ["to": ["a@@b"], "subject": "", "body": ""],
            ["to": ["@b"], "subject": "", "body": ""], ["to": ["a@"], "subject": "", "body": ""],
            ["to": ["a@b\n"], "subject": "", "body": ""], ["to": [.string(long)], "subject": "", "body": ""],
            ["to": "a@b", "subject": "", "body": ""], ["to": [5], "subject": "", "body": ""], ["to": [""], "subject": "", "body": ""],
            ["to": ["a@b"], "subject": "a\nBcc: x@y", "body": ""], ["to": ["a@b"], "body": ""], ["to": ["a@b"], "subject": ""],
            ["to": ["a@b"], "subject": .string(String(repeating: "s", count: 501)), "body": ""],
            ["to": ["a@b"], "subject": "", "body": .string(String(repeating: "b", count: 50_001))],
            ["to": ["a@b"], "subject": "", "body": "\u{0}"], ["to": ["a@b"], "subject": "", "body": "", "send": true],
            ["to": ["a@b"], "subject": "", "body": "", "bcc": ["c@d"]],
        ] {
            try assertError("invalid_params", "mail.createDraft", bad)
        }
        XCTAssertTrue(automation.calls.isEmpty)
        XCTAssertTrue(AutomationService.isValidEmail(String(repeating: "a", count: 308) + "@example.com"))
        XCTAssertFalse(AutomationService.isValidEmail(String(repeating: "a", count: 309) + "@example.com"))
    }

    // MARK: - No send capability

    func testNothingCanSendMail() throws {
        for method in ["mail.send", "mail.sendDraft", "mail.reply", "mail.forward", "mail.redirect", "mail.delete",
                       "mail.move", "notes.delete", "notes.update", "applescript.run", "automation.call", "osascript"] {
            try assertError("unsupported", method, ["id": "x"])
        }
        XCTAssertTrue(automation.calls.isEmpty)

        let forbidden = ["send", "forward", "reply", "redirect", "delete", "move", "mailto", "geturl", "bounce"]
        for handler in AutomationHandler.allCases {
            let words = handler.rawValue.lowercased().split(separator: "_").map(String.init)
            XCTAssertTrue(Set(words).isDisjoint(with: forbidden), handler.rawValue)
        }
        XCTAssertEqual(Set(AutomationHandler.allCases.map(\.rawValue)), [
            "notes_search", "notes_folders", "notes_read", "notes_create", "mail_scan", "mail_read", "mail_create_draft",
        ])
    }

    func testTemplatesAreFixedAndContainNoDangerousCommands() throws {
        let commands = try NSRegularExpression(
            pattern: #"\b(send|forward|reply|redirect|bounce|delete|move|mailto|GetURL|do shell script|run script|load script|store script|open location|system attribute|osascript)\b"#,
            options: [.caseInsensitive])
        for app in AutomationApp.allCases {
            let source = AutomationTemplates.source(for: app)
            // Comments may mention forbidden words in prose; only code lines count.
            let code = source.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("--") }
                .joined(separator: "\n")
            let range = NSRange(code.startIndex..., in: code)
            XCTAssertNil(commands.firstMatch(in: code, range: range).map { (code as NSString).substring(with: $0.range) }, app.rawValue)
            // The only targets are Notes (notes template) and Mail (mail template).
            let tells = code.components(separatedBy: "tell application \"").dropFirst().map { $0.prefix { $0 != "\"" } }
            XCTAssertEqual(Set(tells), [app == .notes ? "Notes" : "Mail"], app.rawValue)
        }
        for handler in AutomationHandler.allCases {
            XCTAssertTrue(AutomationTemplates.source(for: handler.app).contains("on \(handler.rawValue)("), handler.rawValue)
        }
    }

    // MARK: - Error mapping

    func testAppleEventErrorMapping() throws {
        XCTAssertEqual(AutomationService.mapError(-1743), BridgeError(.permission, "automation: denied"))
        XCTAssertEqual(AutomationService.mapError(-1744), BridgeError(.permission, "automation: not-requested"))
        XCTAssertEqual(AutomationService.mapError(-1728).code, .notFound)
        XCTAssertEqual(AutomationService.mapError(-1719).code, .notFound)
        XCTAssertEqual(AutomationService.mapError(-600), BridgeError(.io, "app is not running"))
        XCTAssertEqual(AutomationService.mapError(-1712), BridgeError(.io, "automation timed out"))
        XCTAssertEqual(AutomationService.mapError(-10810).code, .io)
        XCTAssertEqual(AutomationService.mapError(-2753), BridgeError(.io, "automation failed (-2753)"))

        automation.responses[.notesSearch] = .failure(AutomationService.mapError(-1743))
        try assertError("permission", "notes.search", ["query": "a"], message: "automation: denied")
        automation.responses[.mailScan] = .failure(AutomationService.mapError(-1743))
        try assertError("permission", "mail.search", ["query": "a"], message: "automation: denied")
        automation.responses[.mailCreateDraft] = .failure(AutomationService.mapError(-1743))
        try assertError("permission", "mail.createDraft", ["to": ["a@b"], "subject": "", "body": ""], message: "automation: denied")
        automation.responses[.notesRead] = .failure(AutomationService.mapError(-600))
        try assertError("io", "notes.read", ["id": "x-coredata://a/ICNote/p1"], message: "app is not running")
    }

    // MARK: - Descriptor bridge (pure data; nothing is sent)

    func testDescriptorConversionRoundTrips() throws {
        let when = Date(timeIntervalSince1970: 1_800_000_123)
        let value: ScriptValue = .list([
            .string("héllo \"quoted\" & end tell"), .int(42), .int(-7), .bool(true), .bool(false), .double(2.5), .date(when),
            .list([.string("nested"), .list([])]), .null,
        ])
        XCTAssertEqual(AppleScriptBackend.value(AppleScriptBackend.descriptor(value)), value)
        // Out-of-Int32 integers travel as reals; the parsers accept integral reals.
        XCTAssertEqual(AppleScriptBackend.value(AppleScriptBackend.descriptor(.int(5_000_000_000))), .double(5_000_000_000))
        XCTAssertEqual(try AutomationService.int(.double(5_000_000_000)), 5_000_000_000)
        XCTAssertThrowsError(try AutomationService.int(.double(1.5)))
        // `missing value` is typeType 'msng'.
        let missing = NSAppleEventDescriptor(typeCode: AppleScriptBackend.fourCharCode("msng"))
        XCTAssertEqual(AppleScriptBackend.value(missing), .null)
        XCTAssertEqual(AppleScriptBackend.value(NSAppleEventDescriptor.list()), .list([]))
    }

    func testHandlerCallEventShape() throws {
        let event = AppleScriptBackend.handlerEvent(.mailCreateDraft, [.list([.string("a@b")]), .list([]), .string("s"), .string("b")])
        XCTAssertEqual(event.eventClass, AppleScriptBackend.fourCharCode("ascr"))  // kASAppleScriptSuite
        XCTAssertEqual(event.eventID, AppleScriptBackend.fourCharCode("psbr"))  // kASSubroutineEvent
        XCTAssertEqual(event.paramDescriptor(forKeyword: AppleScriptBackend.fourCharCode("snam"))?.stringValue, "mail_create_draft")
        let direct = try XCTUnwrap(event.paramDescriptor(forKeyword: AppleScriptBackend.fourCharCode("----")))
        XCTAssertEqual(AppleScriptBackend.value(direct), .list([.list([.string("a@b")]), .list([]), .string("s"), .string("b")]))
    }

    /// Opt-in (YO_COMPILE_APPLESCRIPT=1): compiles both templates with NSAppleScript. Compiling reads
    /// the apps' scripting dictionaries but executes nothing and sends no handler events.
    func testTemplatesCompile() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["YO_COMPILE_APPLESCRIPT"] == "1", "set YO_COMPILE_APPLESCRIPT=1")
        for app in AutomationApp.allCases {
            let script = try XCTUnwrap(NSAppleScript(source: AutomationTemplates.source(for: app)))
            var error: NSDictionary?
            XCTAssertTrue(script.compileAndReturnError(&error), "\(app): \(String(describing: error))")
        }
    }
}
