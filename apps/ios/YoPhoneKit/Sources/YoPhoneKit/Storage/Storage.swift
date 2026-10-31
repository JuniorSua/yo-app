import Foundation
import Security

/// What a session keeps between launches. The link itself lives in the Keychain, not here.
public struct SessionSnapshot: Codable, Equatable, Sendable {
    public var items: [ChatItem]
    /// The last `out` seq this phone accepted.
    public var cursor: Int
    /// The core's counter on the last message accepted; nil until one arrives with a counter.
    public var lastN: Int64?
    public var agentName: String
    public var pairedAt: Date?
    public var lastHello: Date?

    public init(items: [ChatItem] = [], cursor: Int = 0, lastN: Int64? = nil, agentName: String = "Yo",
                pairedAt: Date? = nil, lastHello: Date? = nil) {
        self.items = items
        self.cursor = cursor
        self.lastN = lastN
        self.agentName = agentName
        self.pairedAt = pairedAt
        self.lastHello = lastHello
    }
}

@MainActor
public protocol SessionStore: AnyObject {
    func load() -> SessionSnapshot?
    func save(_ snapshot: SessionSnapshot)
    func clear()
}

/// Conversation history and cursor as JSON in Application Support.
@MainActor
public final class FileSessionStore: SessionStore {
    private let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// `Application Support/Yo/session.json`, excluded from backups.
    public static func standard() -> FileSessionStore {
        let dir = URL.applicationSupportDirectory.appending(path: "Yo", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = dir
        try? excluded.setResourceValues(values)
        return FileSessionStore(url: dir.appending(path: "session.json"))
    }

    public func load() -> SessionSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SessionSnapshot.self, from: data)
    }

    public func save(_ snapshot: SessionSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// Keeps a session in memory only: the demo, screenshots and tests.
@MainActor
public final class MemorySessionStore: SessionStore {
    public private(set) var snapshot: SessionSnapshot?

    public init(_ snapshot: SessionSnapshot? = nil) {
        self.snapshot = snapshot
    }

    public func load() -> SessionSnapshot? { snapshot }
    public func save(_ snapshot: SessionSnapshot) { self.snapshot = snapshot }
    public func clear() { snapshot = nil }
}

/// Where the phone link is kept.
public protocol LinkVault: Sendable {
    func load() -> PhoneLink?
    func save(_ link: PhoneLink) throws
    func clear()
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

/// The phone link in the Keychain, readable after the first unlock and never synced or restored to another device.
public struct KeychainLinkVault: LinkVault {
    private let service: String
    private let account: String

    public init(service: String = "dev.yo.phone.link", account: String = "phone-link") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func load() -> PhoneLink? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(PhoneLink.self, from: data)
    }

    public func save(_ link: PhoneLink) throws {
        let data = try JSONEncoder().encode(link)
        clear()
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
