import Foundation

/// A value crossing the Apple Events boundary. Arguments are converted to NSAppleEventDescriptor
/// values; they are never turned into script source.
public indirect enum ScriptValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case date(Date)
    case list([ScriptValue])
}

public enum AutomationApp: String, Sendable, CaseIterable {
    case notes, mail
}

/// The complete set of handlers in the fixed templates (AutomationTemplates). There is no handler
/// that sends, forwards, replies to, redirects, moves or deletes anything.
public enum AutomationHandler: String, Sendable, CaseIterable {
    case notesSearch = "notes_search"
    case notesFolders = "notes_folders"
    case notesRead = "notes_read"
    case notesCreate = "notes_create"
    case mailScan = "mail_scan"
    case mailRead = "mail_read"
    case mailCreateDraft = "mail_create_draft"

    public var app: AutomationApp {
        switch self {
        case .notesSearch, .notesFolders, .notesRead, .notesCreate: return .notes
        case .mailScan, .mailRead, .mailCreateDraft: return .mail
        }
    }
}

public protocol AutomationBackend: AnyObject {
    /// Calls one handler of the app's fixed, compiled template with positional arguments.
    /// Errors are already mapped with `AutomationService.mapError`.
    func call(_ handler: AutomationHandler, _ args: [ScriptValue]) throws(BridgeError) -> ScriptValue
}

/// Apple Notes and Mail methods: validation, result parsing, matching, sorting and truncation.
final class AutomationService {
    enum Limit {
        static let queryBytes = 200
        static let noteIdBytes = 512
        static let mailIdBytes = 256
        static let titleBytes = 500
        static let noteBodyBytes = 50_000
        static let folderBytes = 200
        static let subjectBytes = 500
        static let mailBodyBytes = 50_000
        static let emailBytes = 320
        static let recipients = 20
        static let accountIdBytes = 128
        static let textCharacters = 100_000
        /// notes.search considers only this many most recently modified notes.
        static let notesScan = 2000
        /// mail.search reads at most this many newest messages per account mailbox.
        static let mailScan = 500
    }

    static let mailboxes: Set<String> = ["inbox", "sent", "drafts"]

    private let backend: AutomationBackend

    init(backend: AutomationBackend) {
        self.backend = backend
    }

    // MARK: - Notes

    func notesSearch(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let query = try Self.query(&params)
        let limit = try Self.limit(&params)
        try params.finish()

        let raw = try Self.list(try backend.call(.notesSearch, [.string(query)]), count: 5)
        let ids = try Self.list(raw[0]).map { (v: ScriptValue) throws(BridgeError) in try Self.string(v) }
        let names = try Self.list(raw[1]).map { (v: ScriptValue) throws(BridgeError) in try Self.string(v, nullAs: "") }
        let dates = try Self.list(raw[2]).map { (v: ScriptValue) throws(BridgeError) in try Self.optionalDate(v) }
        let locked = try Self.list(raw[3]).map { (v: ScriptValue) throws(BridgeError) in try Self.bool(v, nullAs: true) }
        let bodyMatches = Set(try Self.list(raw[4]).map { (v: ScriptValue) throws(BridgeError) in try Self.string(v) })
        guard names.count == ids.count, dates.count == ids.count, locked.count == ids.count else {
            throw BridgeError(.io, "notes changed during the search")
        }

        let recent = ids.indices.sorted { a, b in
            dates[a] == dates[b] ? ids[a] < ids[b] : Self.newerFirst(dates[a], dates[b])
        }.prefix(Limit.notesScan)
        // Locked notes can match by title (visible in Notes) but never by body.
        let matches = Array(recent.filter { i in
            Self.contains(names[i], query) || (!locked[i] && bodyMatches.contains(ids[i]))
        }.prefix(limit))
        guard !matches.isEmpty else { return ["notes": []] }

        let folders = try Self.list(try backend.call(.notesFolders, [.list(matches.map { .string(ids[$0]) })]))
            .map { (v: ScriptValue) throws(BridgeError) in try Self.string(v, nullAs: "") }
        guard folders.count == matches.count else { throw BridgeError(.io, "unexpected automation result") }
        return [
            "notes": .array(zip(matches, folders).map { i, folder in
                ["id": .string(ids[i]), "name": .string(names[i]), "folder": .string(folder), "modified": Self.ms(dates[i])]
            })
        ]
    }

    func notesRead(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let id = try params.string("id", maxBytes: Limit.noteIdBytes)
        try params.finish()
        guard id.hasPrefix("x-coredata://"), !Self.hasControlOrSpace(id) else {
            throw BridgeError.invalidParams("id must be a Notes id")
        }

        let raw = try Self.list(try backend.call(.notesRead, [.string(id)]), count: 6)
        if try Self.bool(raw[4], nullAs: true) { throw BridgeError(.protected, "note is password protected") }
        let (text, truncated) = Self.truncate(try Self.string(raw[5], nullAs: ""))
        return [
            "id": .string(try Self.string(raw[0])), "name": .string(try Self.string(raw[1], nullAs: "")),
            "folder": .string(try Self.string(raw[2], nullAs: "")), "modified": Self.ms(try Self.optionalDate(raw[3])),
            "text": .string(text), "truncated": .bool(truncated),
        ]
    }

    func notesCreate(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let folder = try params.optionalString("folder", maxBytes: Limit.folderBytes)
        let title = try params.string("title", maxBytes: Limit.titleBytes)
        let body = try params.string("body", maxBytes: Limit.noteBodyBytes)
        try params.finish()
        if let folder {
            guard !folder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !Self.hasControl(folder) else {
                throw BridgeError.invalidParams("folder must be a non-blank single line or null")
            }
        }
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !Self.hasControl(title) else {
            throw BridgeError.invalidParams("title must be a non-blank single line")
        }
        guard !Self.hasControl(body, allowing: ["\n", "\r", "\t"]) else {
            throw BridgeError.invalidParams("body contains a control character")
        }

        let html = Self.noteHTML(title: title, body: body)
        let id = try Self.string(try backend.call(.notesCreate, [.string(folder ?? ""), .string(html)]))
        return ["id": .string(id)]
    }

    /// Plain text to the simple HTML Notes stores: the title as a heading (Notes names the note
    /// after its first line), then one `<div>` per line. Every character of user text is escaped.
    static func noteHTML(title: String, body: String) -> String {
        var html = "<div><h1>" + escapeHTML(title) + "</h1></div>"
        guard !body.isEmpty else { return html }
        let normalized = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        for line in normalized.split(separator: "\n", omittingEmptySubsequences: false) {
            html += line.isEmpty ? "<div><br></div>" : "<div>" + escapeHTML(String(line)) + "</div>"
        }
        return html
    }

    static func escapeHTML(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.utf8.count)
        for character in text {
            switch character {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(character)
            }
        }
        return out
    }

    // MARK: - Mail

    func mailSearch(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let query = try Self.query(&params)
        let limit = try Self.limit(&params)
        let mailbox = try params.string("mailbox", default: "inbox", maxBytes: 16)
        try params.finish()
        guard Self.mailboxes.contains(mailbox) else { throw BridgeError.invalidParams("mailbox must be inbox, sent or drafts") }

        struct Found {
            var id: String
            var subject: String
            var sender: String
            var date: Date?
            var account: String
            var read: Bool
        }
        var found: [Found] = []
        let scanned = try Self.list(try backend.call(.mailScan, [.string(mailbox), .int(Int64(Limit.mailScan))]))
        for entry in scanned {
            let fields = try Self.list(entry, count: 7)
            let accountId = try Self.string(fields[0], nullAs: "")
            let account = try Self.string(fields[1], nullAs: "")
            let ids = try Self.list(fields[2]).map { (v: ScriptValue) throws(BridgeError) in try Self.int(v) }
            let subjects = try Self.list(fields[3]).map { (v: ScriptValue) throws(BridgeError) in try Self.string(v, nullAs: "") }
            let senders = try Self.list(fields[4]).map { (v: ScriptValue) throws(BridgeError) in try Self.string(v, nullAs: "") }
            let dates = try Self.list(fields[5]).map { (v: ScriptValue) throws(BridgeError) in try Self.optionalDate(v) }
            let reads = try Self.list(fields[6]).map { (v: ScriptValue) throws(BridgeError) in try Self.bool(v, nullAs: false) }
            guard subjects.count == ids.count, senders.count == ids.count, dates.count == ids.count, reads.count == ids.count
            else { throw BridgeError(.io, "mailbox changed during the search") }
            // Accounts whose id cannot be represented in a message id are skipped, not guessed.
            guard Self.isValidAccountId(accountId) else { continue }
            for i in ids.indices.prefix(Limit.mailScan) where Self.contains(subjects[i], query) || Self.contains(senders[i], query) {
                found.append(Found(
                    id: Self.mailId(mailbox, accountId, ids[i]), subject: subjects[i], sender: senders[i], date: dates[i],
                    account: account, read: reads[i]))
            }
        }
        found.sort { a, b in a.date == b.date ? a.id < b.id : Self.newerFirst(a.date, b.date) }
        return [
            "messages": .array(found.prefix(limit).map {
                [
                    "id": .string($0.id), "subject": .string($0.subject), "sender": .string($0.sender), "date": Self.ms($0.date),
                    "account": .string($0.account), "mailbox": .string(mailbox), "read": .bool($0.read),
                ]
            })
        ]
    }

    func mailRead(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let id = try params.string("id", maxBytes: Limit.mailIdBytes)
        try params.finish()
        let (mailbox, accountId, messageId) = try Self.parseMailId(id)

        let raw = try Self.list(
            try backend.call(.mailRead, [.string(mailbox), .string(accountId), .int(messageId)]), count: 7)
        let to = try Self.list(raw[3]).map { (v: ScriptValue) throws(BridgeError) in try Self.string(v) }
        let cc = try Self.list(raw[4]).map { (v: ScriptValue) throws(BridgeError) in try Self.string(v) }
        let (content, truncated) = Self.truncate(try Self.string(raw[6], nullAs: ""))
        return [
            "id": .string(Self.mailId(mailbox, accountId, try Self.int(raw[0]))),
            "subject": .string(try Self.string(raw[1], nullAs: "")), "sender": .string(try Self.string(raw[2], nullAs: "")),
            "to": .array(to.map(JSONValue.string)), "cc": .array(cc.map(JSONValue.string)),
            "date": Self.ms(try Self.optionalDate(raw[5])), "content": .string(content), "truncated": .bool(truncated),
        ]
    }

    /// Creates an invisible outgoing message and saves it as a draft. Nothing in the helper can send it.
    func mailCreateDraft(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let to = try params.stringArray("to", minCount: 1, maxCount: Limit.recipients, maxBytes: Limit.emailBytes)
        let cc = try params.stringArray("cc", default: [], minCount: 0, maxCount: Limit.recipients, maxBytes: Limit.emailBytes)
        let subject = try params.string("subject", maxBytes: Limit.subjectBytes)
        let body = try params.string("body", maxBytes: Limit.mailBodyBytes)
        try params.finish()
        guard (to + cc).allSatisfy(Self.isValidEmail) else { throw BridgeError.invalidParams("invalid email address") }
        guard !Self.hasControl(subject) else { throw BridgeError.invalidParams("subject must be a single line") }
        guard !Self.hasControl(body, allowing: ["\n", "\r", "\t"]) else {
            throw BridgeError.invalidParams("body contains a control character")
        }

        let result = try backend.call(
            .mailCreateDraft, [.list(to.map(ScriptValue.string)), .list(cc.map(ScriptValue.string)), .string(subject), .string(body)])
        return ["id": .string("outgoing:\(try Self.int(result))")]
    }

    /// Loose check: one "@" with text on both sides, at most 320 bytes, no whitespace, control
    /// characters or address-list syntax (`, ; < > " ( ) [ ] \ :`) that could smuggle extra recipients.
    static func isValidEmail(_ address: String) -> Bool {
        guard !address.isEmpty, address.utf8.count <= Limit.emailBytes else { return false }
        let forbidden = Set(",;<>\"()[]\\:".unicodeScalars)
        guard !address.unicodeScalars.contains(where: {
            forbidden.contains($0) || $0.properties.isWhitespace || $0.properties.generalCategory == .control
        }) else { return false }
        let parts = address.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty
    }

    /// Message ids are `<mailbox>:<account id>:<Mail message id>`, e.g. `inbox:6C1F…-…:48213`.
    static func mailId(_ mailbox: String, _ accountId: String, _ messageId: Int64) -> String {
        "\(mailbox):\(accountId):\(messageId)"
    }

    static func parseMailId(_ id: String) throws(BridgeError) -> (String, String, Int64) {
        let parts = id.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, mailboxes.contains(parts[0]), isValidAccountId(parts[1]),
            parts[2].utf8.count <= 18, parts[2].utf8.allSatisfy({ (0x30...0x39).contains($0) }),
            let number = Int64(parts[2]), number > 0
        else { throw BridgeError.invalidParams("id must be a mail.search message id") }
        return (parts[0], parts[1], number)
    }

    static func isValidAccountId(_ id: String) -> Bool {
        id.utf8.count <= Limit.accountIdBytes
            && id.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || $0 == 0x2D || $0 == 0x2E || $0 == 0x5F }
    }

    // MARK: - Errors

    /// Maps an AppleScript/Apple Event error number. Messages are fixed strings; the script's own
    /// error text (which may contain data) is never returned.
    static func mapError(_ number: Int) -> BridgeError {
        switch number {
        case -1743: return BridgeError(.permission, "automation: denied")  // errAEEventNotPermitted
        case -1744: return BridgeError(.permission, "automation: not-requested")  // errAEEventWouldRequireUserConsent
        case -1728, -1719: return BridgeError(.notFound, "item not found")  // errAENoSuchObject, errAEIllegalIndex
        case -600, -609: return BridgeError(.io, "app is not running")  // procNotFound, connectionInvalid
        case -10810, -10827, -10660: return BridgeError(.io, "app could not be launched")
        case -1712: return BridgeError(.io, "automation timed out")  // errAETimeout
        case -128: return BridgeError(.io, "automation was cancelled")  // userCanceledErr
        default: return BridgeError(.io, "automation failed (\(number))")
        }
    }

    // MARK: - Parsing helpers

    private static func query(_ params: inout Params) throws(BridgeError) -> String {
        let query = try params.string("query", maxBytes: Limit.queryBytes).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { throw BridgeError.invalidParams("query must not be empty") }
        guard !hasControl(query) else { throw BridgeError.invalidParams("query must be a single line") }
        return query
    }

    private static func limit(_ params: inout Params) throws(BridgeError) -> Int {
        let limit = try params.int("limit", default: 20)
        guard (1...50).contains(limit) else { throw BridgeError.invalidParams("limit must be 1...50") }
        return limit
    }

    static func contains(_ text: String, _ query: String) -> Bool {
        text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }

    /// Truncates to `Limit.textCharacters` characters.
    static func truncate(_ text: String) -> (String, Bool) {
        guard text.count > Limit.textCharacters else { return (text, false) }
        return (String(text.prefix(Limit.textCharacters)), true)
    }

    static func hasControl(_ text: String, allowing allowed: Set<Unicode.Scalar> = []) -> Bool {
        text.unicodeScalars.contains { $0.properties.generalCategory == .control && !allowed.contains($0) }
            || text.unicodeScalars.contains { $0 == "\u{2028}" || $0 == "\u{2029}" }
    }

    private static func hasControlOrSpace(_ text: String) -> Bool {
        hasControl(text) || text.unicodeScalars.contains { $0.properties.isWhitespace }
    }

    private static func newerFirst(_ a: Date?, _ b: Date?) -> Bool {
        switch (a, b) {
        case (let a?, let b?): return a > b
        case (nil, _): return false
        case (_, nil): return true
        }
    }

    private static func ms(_ date: Date?) -> JSONValue {
        date.map { .int(PIMService.ms($0)) } ?? .null
    }

    private static func unexpected() -> BridgeError { BridgeError(.io, "unexpected automation result") }

    static func list(_ value: ScriptValue, count: Int? = nil) throws(BridgeError) -> [ScriptValue] {
        guard case .list(let items) = value else { throw unexpected() }
        if let count, items.count != count { throw unexpected() }
        return items
    }

    static func string(_ value: ScriptValue, nullAs fallback: String? = nil) throws(BridgeError) -> String {
        switch value {
        case .string(let text): return text
        case .null where fallback != nil: return fallback!
        default: throw unexpected()
        }
    }

    static func bool(_ value: ScriptValue, nullAs fallback: Bool) throws(BridgeError) -> Bool {
        switch value {
        case .bool(let flag): return flag
        case .null: return fallback
        default: throw unexpected()
        }
    }

    static func int(_ value: ScriptValue) throws(BridgeError) -> Int64 {
        switch value {
        case .int(let number): return number
        case .double(let number) where number.rounded() == number && abs(number) < 9e15: return Int64(number)
        default: throw unexpected()
        }
    }

    static func optionalDate(_ value: ScriptValue) throws(BridgeError) -> Date? {
        switch value {
        case .date(let date): return date
        case .null: return nil
        default: throw unexpected()
        }
    }
}
