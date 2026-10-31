import Foundation

public enum ScopeKind: String, Sendable {
    case dir, file
}

public struct ScopeInfo: Equatable, Sendable {
    public let canonicalPath: String
    public let kind: ScopeKind
    public let displayPath: String
    public let stale: Bool
}

public struct ListEntry: Equatable, Sendable {
    public let name: String
    public let kind: String
    public let size: Int64
    public let mtimeMs: Int64
}

public struct ListPage: Equatable, Sendable {
    public let entries: [ListEntry]
    public let nextCursor: String?
}

public struct StatResult: Equatable, Sendable {
    public let kind: String
    public let size: Int64
    public let mtimeMs: Int64
    public let sha256: String?
    public let nlink: Int
}

public struct ReadResult: Equatable, Sendable {
    public let data: Data
    public let size: Int64
    public let sha256: String?
    public let truncated: Bool
    public let mtimeMs: Int64
}

public struct WriteResult: Equatable, Sendable {
    public let sha256: String
    public let size: Int64
}

/// All file access goes through a validated scope: the root is re-resolved and re-validated on
/// every call, then every component below it is opened descriptor-relative with O_NOFOLLOW.
public struct ScopedFiles: Sendable {
    public static let maxFileBytes = 20 * 1024 * 1024
    public static let maxListLimit = 500
    static let tempPrefix = ".yo-tmp-"
    private static let cursorPrefix = "v1:"
    private static let maxBookmarkBytes = 64 * 1024

    public let config: BridgeConfig

    public init(config: BridgeConfig) { self.config = config }

    // MARK: Scopes

    public func createScope(path: String) throws(BridgeError) -> (bookmark: String, info: ScopeInfo) {
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw BridgeError(.invalidPath, "path must be absolute") }
        guard path.utf8.count < Int(MAXPATHLEN) else { throw BridgeError(.invalidPath, "path too long") }
        guard let canonical = PathPolicy.realpath(path) else {
            throw errno == ENOENT ? BridgeError(.notFound, "path does not exist") : BridgeError.errno(errno, "resolve")
        }
        let scope = try open(canonicalPath: canonical, stale: false)
        let bookmark: Data
        do {
            bookmark = try URL(fileURLWithPath: scope.info.canonicalPath).bookmarkData(
                options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        } catch {
            throw BridgeError(.io, "could not create bookmark")
        }
        return (bookmark.base64EncodedString(), scope.info)
    }

    public func resolveScope(bookmark: String) throws(BridgeError) -> ScopeInfo {
        try open(bookmark: bookmark).info
    }

    // MARK: Files

    public func list(bookmark: String, relPath: String, limit: Int, cursor: String?) throws(BridgeError) -> ListPage {
        guard (1...Self.maxListLimit).contains(limit) else { throw BridgeError.invalidParams("limit out of range") }
        let after = try cursor.map(Self.decodeCursor)
        let scope = try open(bookmark: bookmark)
        guard scope.info.kind == .dir else { throw BridgeError(.notADirectory, "scope is a single file") }
        let directory: Descriptor
        switch try target(scope, relPath) {
        case .root(let root): directory = root
        case .entry(let parent, let name): directory = try FS.openDirectory(in: parent, name)
        }

        var names: [String] = []
        let streamFD = dup(directory.raw)
        guard streamFD >= 0, let stream = fdopendir(streamFD) else {
            if streamFD >= 0 { close(streamFD) }
            throw BridgeError.errno(errno, "list")
        }
        defer { closedir(stream) }
        while let entry = readdir(stream) {
            // Names that are not valid UTF-8 could not be addressed by a later relPath; skip them.
            let name = withUnsafeBytes(of: entry.pointee.d_name) { raw in
                String(validatingCString: raw.bindMemory(to: CChar.self).baseAddress!)
            }
            guard let name, name != ".", name != "..", !PathPolicy.isProtectedName(name) else { continue }
            if let after, !Self.precedes(after, name) { continue }
            names.append(name)
        }
        names.sort(by: Self.precedes)

        var entries: [ListEntry] = []
        var index = 0
        while entries.count < limit, index < names.count {
            let name = names[index]
            index += 1
            // An entry removed since readdir is simply skipped.
            guard let info = try? FS.lstat(in: directory, name) else { continue }
            entries.append(ListEntry(name: name, kind: info.kind.rawValue, size: Int64(info.st_size), mtimeMs: info.mtimeMs))
        }
        // The cursor is the last name examined, so skipped (vanished) entries cannot stall paging.
        let nextCursor = index < names.count ? Self.encodeCursor(names[index - 1]) : nil
        return ListPage(entries: entries, nextCursor: nextCursor)
    }

    public func stat(bookmark: String, relPath: String) throws(BridgeError) -> StatResult {
        let scope = try open(bookmark: bookmark)
        let descriptor: Descriptor
        let info: Darwin.stat
        switch try target(scope, relPath) {
        case .root(let root):
            descriptor = root
            info = try root.stat()
        case .entry(let parent, let name):
            let preview = try FS.lstat(in: parent, name)
            switch preview.kind {
            case .symlink:
                throw BridgeError(.symlink, "symbolic links are not followed")
            case .other:
                return StatResult(kind: "other", size: Int64(preview.st_size), mtimeMs: preview.mtimeMs, sha256: nil,
                                  nlink: Int(preview.st_nlink))
            case .file, .dir:
                (descriptor, info) = try FS.openEntry(in: parent, name)
            }
        }
        // A hard-linked file may be the same inode as a secret outside the scope; don't hash it.
        let hashable = info.kind == .file && info.st_nlink == 1 && info.st_size <= Self.maxFileBytes
        let sha = hashable ? try fullFileHash(descriptor) : nil
        return StatResult(kind: info.kind.rawValue, size: Int64(info.st_size), mtimeMs: info.mtimeMs, sha256: sha,
                          nlink: Int(info.st_nlink))
    }

    public func read(bookmark: String, relPath: String, maxBytes: Int) throws(BridgeError) -> ReadResult {
        guard (1...Self.maxFileBytes).contains(maxBytes) else { throw BridgeError.invalidParams("maxBytes out of range") }
        let scope = try open(bookmark: bookmark)
        let (file, info) = try openRegularFile(try target(scope, relPath))
        let size = Int64(info.st_size)
        if size <= Self.maxFileBytes {
            let whole = try FS.read(file, limit: Self.maxFileBytes + 1)
            if whole.count <= Self.maxFileBytes {
                let truncated = whole.count > maxBytes
                return ReadResult(data: truncated ? whole.prefix(maxBytes) : whole, size: Int64(whole.count),
                                  sha256: FS.sha256Hex(whole), truncated: truncated, mtimeMs: info.mtimeMs)
            }
        }
        // Too large to hash within limits: return the prefix only.
        let prefix = try FS.read(file, limit: maxBytes)
        return ReadResult(data: prefix, size: size, sha256: nil, truncated: true, mtimeMs: info.mtimeMs)
    }

    /// `expectedSha256 == nil` creates a new file (fails with `exists` if anything is present);
    /// otherwise replaces an existing single-link regular file whose content hash matches.
    public func write(bookmark: String, relPath: String, data: Data, expectedSha256: String?) throws(BridgeError)
        -> WriteResult
    {
        guard data.count <= Self.maxFileBytes else { throw BridgeError(.tooLarge, "data exceeds the write limit") }
        let scope = try open(bookmark: bookmark)
        guard case .entry(let parent, let name) = try target(scope, relPath) else {
            throw BridgeError(.notAFile, "cannot write to a directory scope root")
        }

        var mode: mode_t = 0o644
        var existing: Darwin.stat?
        if let expected = expectedSha256 {
            let current = try checkReplacePrecondition(parent, name, expected: expected)
            mode = current.st_mode & 0o777
            existing = current
        } else {
            try checkCreatePrecondition(parent, name)
        }

        let tempName = Self.tempPrefix + FS.randomHex(bytes: 12)
        let tempFD = openat(parent.raw, tempName, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, mode)
        guard tempFD >= 0 else { throw BridgeError.errno(errno, "create temporary file") }
        var committed = false
        defer { if !committed { unlinkat(parent.raw, tempName, 0) } }
        do {
            let temp = Descriptor(tempFD)
            // fchmod so the umask cannot change the intended permission bits.
            guard fchmod(temp.raw, mode) == 0 else { throw BridgeError.errno(errno, "chmod") }
            try FS.writeAll(temp, data)
            guard fsync(temp.raw) == 0 else { throw BridgeError.errno(errno, "fsync") }
        }

        if let expected = expectedSha256, let existing {
            let current = try checkReplacePrecondition(parent, name, expected: expected)
            guard current.isSameFile(as: existing) else { throw BridgeError(.conflict, "file changed during write") }
            guard renameat(parent.raw, tempName, parent.raw, name) == 0 else { throw BridgeError.errno(errno, "rename") }
        } else {
            try checkCreatePrecondition(parent, name)
            guard renameatx_np(parent.raw, tempName, parent.raw, name, UInt32(RENAME_EXCL)) == 0 else {
                throw BridgeError.errno(errno, "rename")
            }
        }
        committed = true
        _ = fsync(parent.raw)

        // Report what is actually on disk now, not what we intended to write.
        let (file, info) = try openRegularFile(.entry(parent, name))
        guard let sha = try fullFileHash(file) else { throw BridgeError(.conflict, "file changed after write") }
        return WriteResult(sha256: sha, size: Int64(info.st_size))
    }

    // MARK: Internals

    struct OpenScope {
        let info: ScopeInfo
        /// The root directory for a dir scope, or the parent directory for a file scope.
        let directory: Descriptor
        /// Set only for a file scope.
        let fileName: String?
    }

    enum Target {
        case root(Descriptor)
        case entry(Descriptor, String)
    }

    func open(bookmark: String) throws(BridgeError) -> OpenScope {
        guard bookmark.utf8.count <= Self.maxBookmarkBytes * 2, let data = Data(base64Encoded: bookmark),
            !data.isEmpty, data.count <= Self.maxBookmarkBytes
        else { throw BridgeError.invalidParams("bookmark is not valid base64") }
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: data, options: [.withoutUI, .withoutMounting], relativeTo: nil,
                          bookmarkDataIsStale: &stale)
        } catch {
            throw BridgeError(.staleScope, "scope could not be resolved")
        }
        guard url.isFileURL, let canonical = PathPolicy.realpath(url.path) else {
            throw BridgeError(.staleScope, "scope could not be resolved")
        }
        return try open(canonicalPath: canonical, stale: stale)
    }

    /// Validates a canonical path against policy, opens it without following any symlink in the
    /// path, then re-validates the kernel's view of what was actually opened.
    private func open(canonicalPath: String, stale: Bool) throws(BridgeError) -> OpenScope {
        try PathPolicy.validateScopeRoot(canonicalPath, config: config)
        var info = Darwin.stat()
        guard Darwin.lstat(canonicalPath, &info) == 0 else { throw BridgeError.errno(errno, "stat") }

        switch info.kind {
        case .dir:
            let fd = Darwin.open(canonicalPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard fd >= 0 else { throw scopeOpenFailure(errno) }
            let root = Descriptor(fd)
            let opened = try root.currentPath()
            try PathPolicy.validateScopeRoot(opened, config: config)
            return OpenScope(info: makeInfo(opened, .dir, stale), directory: root, fileName: nil)
        case .file:
            let parentPath = (canonicalPath as NSString).deletingLastPathComponent
            let name = (canonicalPath as NSString).lastPathComponent
            let fd = Darwin.open(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard fd >= 0 else { throw scopeOpenFailure(errno) }
            let parent = Descriptor(fd)
            let openedParent = try parent.currentPath()
            let opened = openedParent == "/" ? "/" + name : openedParent + "/" + name
            try PathPolicy.validateScopeRoot(opened, config: config)
            let current = try FS.lstat(in: parent, name)
            guard current.kind == .file else { throw BridgeError(.staleScope, "scope is no longer a regular file") }
            return OpenScope(info: makeInfo(opened, .file, stale), directory: parent, fileName: name)
        case .symlink:
            throw BridgeError(.symlink, "symbolic links are not followed")
        case .other:
            throw BridgeError(.invalidPath, "scope must be a directory or a regular file")
        }
    }

    private func scopeOpenFailure(_ code: Int32) -> BridgeError {
        code == ELOOP || code == ENOENT || code == ENOTDIR
            ? BridgeError(.staleScope, "scope changed while opening") : BridgeError.errno(code, "open scope")
    }

    private func makeInfo(_ path: String, _ kind: ScopeKind, _ stale: Bool) -> ScopeInfo {
        ScopeInfo(canonicalPath: path, kind: kind, displayPath: PathPolicy.displayPath(path, config: config),
                  stale: stale)
    }

    /// Walks every intermediate component descriptor-relative; the final component is left to the caller.
    func target(_ scope: OpenScope, _ relPath: String) throws(BridgeError) -> Target {
        let parts = try PathPolicy.components(of: relPath)
        if let fileName = scope.fileName {
            guard parts.isEmpty else { throw BridgeError(.invalidPath, "a single-file scope only accepts an empty path") }
            return .entry(scope.directory, fileName)
        }
        guard let last = parts.last else { return .root(scope.directory) }
        var directory = scope.directory
        for part in parts.dropLast() {
            directory = try FS.openDirectory(in: directory, part)
        }
        return .entry(directory, last)
    }

    private func openRegularFile(_ target: Target) throws(BridgeError) -> (Descriptor, Darwin.stat) {
        guard case .entry(let parent, let name) = target else { throw BridgeError(.notAFile, "not a regular file") }
        let (file, info) = try FS.openEntry(in: parent, name)
        guard info.kind == .file else { throw BridgeError(.notAFile, "not a regular file") }
        guard info.st_nlink == 1 else { throw BridgeError(.hardlink, "hard-linked files are not accessible") }
        return (file, info)
    }

    private func fullFileHash(_ file: Descriptor) throws(BridgeError) -> String? {
        let data = try FS.read(file, limit: Self.maxFileBytes + 1)
        return data.count <= Self.maxFileBytes ? FS.sha256Hex(data) : nil
    }

    private func checkCreatePrecondition(_ parent: Descriptor, _ name: String) throws(BridgeError) {
        var info = Darwin.stat()
        if fstatat(parent.raw, name, &info, AT_SYMLINK_NOFOLLOW) == 0 {
            throw BridgeError(.exists, "file already exists")
        }
        guard errno == ENOENT else { throw BridgeError.errno(errno, "stat") }
    }

    private func checkReplacePrecondition(_ parent: Descriptor, _ name: String, expected: String) throws(BridgeError)
        -> Darwin.stat
    {
        let file: Descriptor
        let info: Darwin.stat
        do {
            (file, info) = try openRegularFile(.entry(parent, name))
        } catch where error.code == .notFound {
            throw BridgeError(.conflict, "file does not exist")
        }
        guard Int64(info.st_size) <= Self.maxFileBytes, try fullFileHash(file) == expected else {
            throw BridgeError(.conflict, "file content does not match expectedSha256")
        }
        return info
    }

    // MARK: Cursor

    /// Byte-wise UTF-8 order: total, locale-independent and stable across calls.
    static func precedes(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
    }

    private static func encodeCursor(_ name: String) -> String {
        Data((cursorPrefix + name).utf8).base64EncodedString()
    }

    private static func decodeCursor(_ cursor: String) throws(BridgeError) -> String {
        guard cursor.utf8.count <= 1024, let data = Data(base64Encoded: cursor),
            let text = String(data: data, encoding: .utf8), text.hasPrefix(cursorPrefix)
        else { throw BridgeError.invalidParams("invalid cursor") }
        return String(text.dropFirst(cursorPrefix.count))
    }
}
