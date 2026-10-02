import Foundation

public enum ExitCode {
    public static let ok: Int32 = 0
    public static let framing: Int32 = 2
    public static let handshake: Int32 = 3
}

public enum SessionAction: Equatable {
    case reply(Data)
    case exit(Int32)
}

/// Protocol state machine: one-time hello, then strictly sequential request/response.
/// Transport-agnostic so it can be driven directly from tests.
public final class Session {
    public static let protocolVersion: Int64 = 1
    public static let version = "0.3.0"
    private static let maxIdBytes = 256

    private let files: ScopedFiles
    private let permissionsProvider: () -> [String: String]
    private let pim: PIMService
    private let windows: WindowService
    private let automation: AutomationService
    private var greeted = false

    /// The default backends use the real Contacts/EventKit stores, window server, Accessibility and
    /// Apple Events. All are created lazily or are stateless; constructing them prompts for nothing.
    /// `excludedPids` are never listable or controllable (by default the helper and its parent, Yo).
    public init(
        config: BridgeConfig, permissions: @escaping () -> [String: String] = Permissions.status,
        contacts: ContactsBackend = ContactsStoreBackend(), calendar: CalendarBackend = EventKitBackend(),
        desktop: DesktopBackends = .live(), excludedPids: Set<Int32> = [getpid(), getppid()],
        automation: AutomationBackend = AppleScriptBackend()
    ) {
        self.files = ScopedFiles(config: config)
        self.permissionsProvider = permissions
        self.pim = PIMService(contacts: contacts, calendar: calendar)
        self.windows = WindowService(backends: desktop, excludedPids: excludedPids)
        self.automation = AutomationService(backend: automation)
    }

    public static var macOSVersion: String { ProcessInfo.processInfo.operatingSystemVersionString }

    public static var arch: String {
        #if arch(arm64)
            return "arm64"
        #else
            return "x86_64"
        #endif
    }

    public func handle(frame: Data) -> SessionAction {
        let message = try? JSONValue.parse(frame)
        guard greeted else { return handleHello(message) }

        if case .object(let dict)? = message, dict["type"] != nil {
            // A second hello (or any other handshake-shaped message) means the parent is confused.
            return .exit(ExitCode.handshake)
        }
        guard case .object(let dict)? = message else {
            return reply(id: .null, error: BridgeError.invalidParams("request must be a JSON object"))
        }
        guard case .string(let id)? = dict["id"], !id.isEmpty, id.utf8.count <= Self.maxIdBytes else {
            return reply(id: .null, error: BridgeError.invalidParams("id must be a non-empty string"))
        }
        guard case .string(let method)? = dict["method"] else {
            return reply(id: .string(id), error: BridgeError.invalidParams("method must be a string"))
        }
        guard dict.keys.allSatisfy(["id", "method", "params"].contains) else {
            return reply(id: .string(id), error: BridgeError.invalidParams("unknown request field"))
        }
        do {
            let result = try dispatch(method: method, params: dict["params"])
            return encode(["id": .string(id), "ok": true, "result": result])
        } catch {
            return reply(id: .string(id), error: error)
        }
    }

    private func handleHello(_ message: JSONValue?) -> SessionAction {
        guard case .object(let dict)? = message, dict.count == 3,
            dict["type"] == "hello",
            dict["protocol"] == .int(Self.protocolVersion),
            case .string(let nonce)? = dict["nonce"],
            (16...256).contains(nonce.utf8.count),
            nonce.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) || (0x41...0x46).contains($0) })
        else { return .exit(ExitCode.handshake) }
        greeted = true
        return encode([
            "type": "hello", "nonce": .string(nonce), "protocol": .int(Self.protocolVersion),
            "version": .string(Self.version), "macos": .string(Self.macOSVersion), "arch": .string(Self.arch),
        ])
    }

    private func dispatch(method: String, params raw: JSONValue?) throws(BridgeError) -> JSONValue {
        var params = try Params(raw)
        let result: JSONValue
        switch method {
        case "status":
            try params.finish()
            result = ["version": .string(Self.version), "macos": .string(Self.macOSVersion), "arch": .string(Self.arch)]

        case "permissions.status":
            try params.finish()
            result = .object(permissionsProvider().mapValues { .string($0) })

        case "scope.create":
            let path = try params.string("path", maxBytes: Int(MAXPATHLEN))
            try params.finish()
            let (bookmark, info) = try files.createScope(path: path)
            result = [
                "bookmark": .string(bookmark), "canonicalPath": .string(info.canonicalPath),
                "kind": .string(info.kind.rawValue), "displayPath": .string(info.displayPath),
            ]

        case "scope.resolve":
            let bookmark = try params.string("bookmark")
            try params.finish()
            let info = try files.resolveScope(bookmark: bookmark)
            result = [
                "canonicalPath": .string(info.canonicalPath), "kind": .string(info.kind.rawValue),
                "displayPath": .string(info.displayPath), "stale": .bool(info.stale),
            ]

        case "files.list":
            let bookmark = try params.string("bookmark")
            let relPath = try params.string("relPath")
            let limit = try params.int("limit", default: 200)
            let cursor = try params.optionalString("cursor")
            try params.finish()
            let page = try files.list(bookmark: bookmark, relPath: relPath, limit: limit, cursor: cursor)
            result = [
                "entries": .array(page.entries.map {
                    ["name": .string($0.name), "kind": .string($0.kind), "size": .int($0.size), "mtimeMs": .int($0.mtimeMs)]
                }),
                "nextCursor": page.nextCursor.map(JSONValue.string) ?? .null,
            ]

        case "files.stat":
            let bookmark = try params.string("bookmark")
            let relPath = try params.string("relPath")
            try params.finish()
            let stat = try files.stat(bookmark: bookmark, relPath: relPath)
            result = [
                "kind": .string(stat.kind), "size": .int(stat.size), "mtimeMs": .int(stat.mtimeMs),
                "sha256": stat.sha256.map(JSONValue.string) ?? .null, "nlink": .int(Int64(stat.nlink)),
            ]

        case "files.read":
            let bookmark = try params.string("bookmark")
            let relPath = try params.string("relPath")
            let maxBytes = try params.int("maxBytes")
            try params.finish()
            let read = try files.read(bookmark: bookmark, relPath: relPath, maxBytes: maxBytes)
            result = [
                "dataBase64": .string(read.data.base64EncodedString()), "size": .int(read.size),
                "sha256": read.sha256.map(JSONValue.string) ?? .null, "truncated": .bool(read.truncated),
                "mtimeMs": .int(read.mtimeMs),
            ]

        case "files.write":
            let bookmark = try params.string("bookmark")
            let relPath = try params.string("relPath")
            let encoded = try params.string("dataBase64")
            let expected = try params.optionalString("expectedSha256", required: true)
            try params.finish()
            // 4 base64 characters per 3 bytes; reject before decoding anything oversized.
            guard encoded.utf8.count <= (ScopedFiles.maxFileBytes + 2) / 3 * 4 else {
                throw BridgeError(.tooLarge, "data exceeds the write limit")
            }
            guard let data = Data(base64Encoded: encoded) else {
                throw BridgeError.invalidParams("dataBase64 is not valid base64")
            }
            let expectedHash = try expected.map(Self.normalizedSha256)
            let written = try files.write(bookmark: bookmark, relPath: relPath, data: data, expectedSha256: expectedHash)
            result = ["sha256": .string(written.sha256), "size": .int(written.size)]

        case "permissions.request":
            let kind = try params.string("kind", maxBytes: 32)
            try params.finish()
            guard let status = pim.requestPermission(kind: kind) ?? windows.requestPermission(kind: kind) else {
                throw BridgeError.invalidParams("kind must be contacts, calendars, reminders, accessibility or screenRecording")
            }
            result = ["status": .string(status.rawValue)]
        case "contacts.search": result = try pim.searchContacts(&params)
        case "calendar.calendars": result = try pim.listCalendars(&params)
        case "calendar.events": result = try pim.listEvents(&params)
        case "calendar.createEvent": result = try pim.createEvent(&params)
        case "calendar.updateEvent": result = try pim.updateEvent(&params)
        case "reminders.lists": result = try pim.listReminderLists(&params)
        case "reminders.list": result = try pim.listReminders(&params)
        case "reminders.create": result = try pim.createReminder(&params)
        case "reminders.complete": result = try pim.completeReminder(&params)

        case "windows.list": result = try windows.list(&params)
        case "window.capture": result = try windows.capture(&params)
        case "window.click": result = try windows.click(&params)
        case "window.type": result = try windows.type(&params)
        case "window.key": result = try windows.key(&params)
        case "window.scroll": result = try windows.scroll(&params)

        // Fixed Apple Events templates. There is deliberately no method that sends mail.
        case "notes.search": result = try automation.notesSearch(&params)
        case "notes.read": result = try automation.notesRead(&params)
        case "notes.create": result = try automation.notesCreate(&params)
        case "mail.search": result = try automation.mailSearch(&params)
        case "mail.read": result = try automation.mailRead(&params)
        case "mail.createDraft": result = try automation.mailCreateDraft(&params)

        default:
            throw BridgeError(.unsupported, "unsupported method")
        }
        return result
    }

    private static func normalizedSha256(_ value: String) throws(BridgeError) -> String {
        let lower = value.lowercased()
        guard lower.utf8.count == 64, lower.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) })
        else { throw BridgeError.invalidParams("expectedSha256 must be 64 hex characters or null") }
        return lower
    }

    private func reply(id: JSONValue, error: BridgeError) -> SessionAction {
        encode(["id": id, "ok": false, "error": ["code": .string(error.code.rawValue), "message": .string(error.message)]])
    }

    private func encode(_ value: JSONValue) -> SessionAction {
        guard let data = try? value.encoded() else { return .exit(ExitCode.framing) }
        if data.count > Framing.maxFrameBytes, case .string(let id)? = value["id"] {
            return reply(id: .string(id), error: BridgeError(.tooLarge, "response exceeds the frame limit"))
        }
        return .reply(data)
    }

    /// Sent before exiting when the peer declares an oversized frame.
    public static func frameTooLargeError() -> Data {
        let value: JSONValue = ["id": nil, "ok": false, "error": ["code": "too_large", "message": "frame exceeds 32 MiB"]]
        return (try? value.encoded()) ?? Data()
    }
}
