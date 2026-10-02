import Foundation

public struct BridgeConfig: Sendable {
    /// Canonical (realpath) home directory. Injectable so tests never touch the real home.
    public let homeDirectory: String

    public init(homeDirectory: String) throws {
        guard let canonical = PathPolicy.realpath(homeDirectory), canonical != "/" else {
            throw BridgeError(.invalidPath, "home directory is not usable")
        }
        self.homeDirectory = canonical
    }

    /// The account's home from the password database, not $HOME, because the parent
    /// launches the helper with a sanitized environment.
    public static func live() throws -> BridgeConfig {
        if let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir {
            return try BridgeConfig(homeDirectory: String(cString: dir))
        }
        return try BridgeConfig(homeDirectory: NSHomeDirectory())
    }
}

public enum PathPolicy {
    public static let maxRelPathBytes = 4096
    public static let maxComponentBytes = 255

    private static let protectedNames: Set<String> = [
        ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc",
        ".git-credentials", ".password-store", "keychains", "login data", "cookies", ".env",
    ]
    private static let protectedPrefixes = [".env.", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
    private static let protectedExtensions = [
        ".pem", ".p12", ".pfx", ".key", ".keychain", ".keychain-db", ".kdbx", ".ovpn",
    ]
    /// Directly under the home directory, these subtrees are never scopable.
    private static let protectedHomeChildren: Set<String> = ["library", ".trash"]

    static func fold(_ name: String) -> String {
        name.precomposedStringWithCanonicalMapping.lowercased()
    }

    /// Case-insensitive match against secret-bearing file and directory names.
    public static func isProtectedName(_ name: String) -> Bool {
        let folded = fold(name)
        if protectedNames.contains(folded) { return true }
        if protectedPrefixes.contains(where: { folded.hasPrefix($0) }) { return true }
        return protectedExtensions.contains(where: { folded.hasSuffix($0) })
    }

    /// Splits a scope-relative path. "" means the scope root.
    public static func components(of relPath: String) throws(BridgeError) -> [String] {
        if relPath.isEmpty { return [] }
        guard relPath.utf8.count <= maxRelPathBytes else { throw BridgeError(.invalidPath, "path too long") }
        guard !relPath.hasPrefix("/") else { throw BridgeError(.invalidPath, "absolute paths are not allowed") }
        let parts = relPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        for part in parts {
            if part.isEmpty { throw BridgeError(.invalidPath, "empty path component") }
            if part == "." || part == ".." { throw BridgeError(.invalidPath, "relative components are not allowed") }
            if part.utf8.contains(0) { throw BridgeError(.invalidPath, "NUL in path") }
            if part.utf8.count > maxComponentBytes { throw BridgeError(.invalidPath, "path component too long") }
            if isProtectedName(part) { throw BridgeError(.protected, "path is protected") }
        }
        return parts
    }

    /// Scope roots must be inside the home directory (excluding the home itself, ~/Library and
    /// ~/.Trash) or on an external volume under /Volumes/<name>. Everything else — "/", /System,
    /// /Library, /Applications, /private, /usr, /bin, /sbin, /etc, /opt, /dev, /cores — falls
    /// outside this allowlist and is rejected. `path` must already be canonical.
    public static func validateScopeRoot(_ path: String, config: BridgeConfig) throws(BridgeError) {
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw BridgeError(.invalidPath, "path must be absolute") }
        let parts = path.split(separator: "/").map(String.init)
        guard !parts.isEmpty else { throw BridgeError(.protected, "path is protected") }
        if parts.contains(where: isProtectedName) { throw BridgeError(.protected, "path is protected") }

        let folded = fold(path)
        let home = fold(config.homeDirectory)
        if folded == home { throw BridgeError(.protected, "the home directory itself cannot be a scope") }
        if folded.hasPrefix(home + "/") {
            let rest = folded.dropFirst(home.count + 1)
            let firstChild = rest.split(separator: "/").first.map(String.init) ?? ""
            if protectedHomeChildren.contains(firstChild) { throw BridgeError(.protected, "path is protected") }
            return
        }
        if fold(parts[0]) == "volumes", parts.count >= 2 { return }
        throw BridgeError(.protected, "path is outside the allowed locations")
    }

    public static func realpath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(validatingCString: resolved)
    }

    public static func displayPath(_ path: String, config: BridgeConfig) -> String {
        let home = config.homeDirectory
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }
}
