import CryptoKit
import Foundation

/// Owned file descriptor, closed on deinit.
final class Descriptor {
    let raw: Int32

    init(_ raw: Int32) { self.raw = raw }

    deinit { close(raw) }

    func stat() throws(BridgeError) -> Darwin.stat {
        var info = Darwin.stat()
        guard fstat(raw, &info) == 0 else { throw BridgeError.errno(errno, "stat") }
        return info
    }

    /// The kernel's current path for this descriptor (used to re-validate scope roots after open).
    func currentPath() throws(BridgeError) -> String {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(raw, F_GETPATH, &buffer) != -1 else { throw BridgeError(.staleScope, "scope location unavailable") }
        guard let path = buffer.withUnsafeBufferPointer({ String(validatingCString: $0.baseAddress!) }) else { throw BridgeError(.staleScope, "scope location unavailable") }
        return path
    }
}

enum FileKind: String {
    case file, dir, symlink, other

    init(mode: mode_t) {
        switch mode & S_IFMT {
        case S_IFREG: self = .file
        case S_IFDIR: self = .dir
        case S_IFLNK: self = .symlink
        default: self = .other
        }
    }
}

extension Darwin.stat {
    var kind: FileKind { FileKind(mode: st_mode) }
    var mtimeMs: Int64 { Int64(st_mtimespec.tv_sec) * 1000 + Int64(st_mtimespec.tv_nsec) / 1_000_000 }
    func isSameFile(as other: Darwin.stat) -> Bool { st_dev == other.st_dev && st_ino == other.st_ino }
}

enum FS {
    /// Stats `name` in `dir` without following a final symlink.
    static func lstat(in dir: Descriptor, _ name: String) throws(BridgeError) -> Darwin.stat {
        var info = Darwin.stat()
        guard fstatat(dir.raw, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw BridgeError.errno(errno, "stat") }
        return info
    }

    /// Opens one directory component below `dir`, never following a symlink.
    static func openDirectory(in dir: Descriptor, _ name: String) throws(BridgeError) -> Descriptor {
        let fd = openat(dir.raw, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw classifyOpenFailure(errno, in: dir, name) }
        return Descriptor(fd)
    }

    /// Opens a regular file or directory below `dir` (never a symlink, FIFO or device) and checks
    /// that the descriptor refers to the same inode that was just inspected.
    static func openEntry(in dir: Descriptor, _ name: String) throws(BridgeError) -> (Descriptor, Darwin.stat) {
        let before = try lstat(in: dir, name)
        let flags: Int32
        switch before.kind {
        case .symlink: throw BridgeError(.symlink, "symbolic links are not followed")
        case .other: throw BridgeError(.notAFile, "not a regular file or directory")
        case .dir: flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        case .file: flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
        }
        let fd = openat(dir.raw, name, flags)
        guard fd >= 0 else { throw classifyOpenFailure(errno, in: dir, name) }
        let descriptor = Descriptor(fd)
        let after = try descriptor.stat()
        guard after.isSameFile(as: before), after.kind == before.kind else {
            throw BridgeError(.conflict, "entry changed during the operation")
        }
        return (descriptor, after)
    }

    /// O_NOFOLLOW reports ELOOP for a symlink, but O_DIRECTORY may win with ENOTDIR; disambiguate.
    private static func classifyOpenFailure(_ code: Int32, in dir: Descriptor, _ name: String) -> BridgeError {
        if code == ENOTDIR || code == ELOOP || code == EMLINK,
            let info = try? lstat(in: dir, name), info.kind == .symlink
        {
            return BridgeError(.symlink, "symbolic links are not followed")
        }
        return BridgeError.errno(code, "open")
    }

    /// Reads from offset 0 until EOF or `limit` bytes.
    static func read(_ fd: Descriptor, limit: Int) throws(BridgeError) -> Data {
        var data = Data()
        let chunk = 1 << 20
        var buffer = [UInt8](repeating: 0, count: chunk)
        while data.count < limit {
            let want = min(chunk, limit - data.count)
            let got = buffer.withUnsafeMutableBytes { pread(fd.raw, $0.baseAddress, want, off_t(data.count)) }
            if got < 0 {
                if errno == EINTR { continue }
                throw BridgeError.errno(errno, "read")
            }
            if got == 0 { break }
            data.append(buffer, count: got)
        }
        return data
    }

    static func writeAll(_ fd: Descriptor, _ data: Data) throws(BridgeError) {
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { raw in
                write(fd.raw, raw.baseAddress! + offset, data.count - offset)
            }
            if written < 0 {
                if errno == EINTR { continue }
                throw BridgeError.errno(errno, "write")
            }
            offset += written
        }
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func randomHex(bytes: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
    }
}
