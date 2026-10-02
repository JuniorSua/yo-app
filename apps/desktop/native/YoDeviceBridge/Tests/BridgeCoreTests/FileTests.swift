import Foundation
import XCTest

@testable import BridgeCore

final class PathSafetyTests: XCTestCase {
    var sandbox: Sandbox!
    var bookmark: String!

    override func setUpWithError() throws {
        sandbox = try Sandbox()
        try sandbox.write("Projects/readme.txt", "inside")
        try sandbox.write("Outside/secret.txt", "outside secret")
        bookmark = try sandbox.scope("Projects")
    }

    func testTraversalAndMalformedPathsRejected() {
        let long = String(repeating: "a", count: 256)
        for relPath in ["../Outside/secret.txt", "a/../../Outside/secret.txt", "..", "./readme.txt", "/etc/passwd",
                        "a//b", "readme.txt/", long, "a\u{0}b"] {
            assertBridgeError(.invalidPath) { try sandbox.files.read(bookmark: bookmark, relPath: relPath, maxBytes: 100) }
        }
        XCTAssertEqual(try PathPolicy.components(of: "a\\b"), ["a\\b"])
    }

    func testSymlinkAsFinalComponent() throws {
        try FileManager.default.createSymbolicLink(
            atPath: sandbox.home + "/Projects/link.txt", withDestinationPath: sandbox.home + "/Outside/secret.txt")
        assertBridgeError(.symlink) { try sandbox.files.read(bookmark: bookmark, relPath: "link.txt", maxBytes: 100) }
        assertBridgeError(.symlink) { try sandbox.files.stat(bookmark: bookmark, relPath: "link.txt") }
        assertBridgeError(.symlink) {
            try sandbox.files.write(bookmark: bookmark, relPath: "link.txt", data: Data("x".utf8),
                                    expectedSha256: sha256("outside secret"))
        }
        assertBridgeError(.exists) {
            try sandbox.files.write(bookmark: bookmark, relPath: "link.txt", data: Data("x".utf8), expectedSha256: nil)
        }
        XCTAssertEqual(try sandbox.read("Outside/secret.txt"), "outside secret")
        XCTAssertEqual(try sandbox.tempFiles(in: "Projects"), [])
    }

    func testSymlinkAsIntermediateDirectory() throws {
        try FileManager.default.createSymbolicLink(atPath: sandbox.home + "/Projects/out", withDestinationPath: sandbox.home + "/Outside")
        assertBridgeError(.symlink) { try sandbox.files.read(bookmark: bookmark, relPath: "out/secret.txt", maxBytes: 100) }
        assertBridgeError(.symlink) { try sandbox.files.list(bookmark: bookmark, relPath: "out", limit: 10, cursor: nil) }
        assertBridgeError(.symlink) {
            try sandbox.files.write(bookmark: bookmark, relPath: "out/new.txt", data: Data("x".utf8), expectedSha256: nil)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: sandbox.home + "/Outside/new.txt"))
    }

    func testSymlinkSwappedInAfterScopeCreation() throws {
        try sandbox.write("Projects/sub/file.txt", "real")
        XCTAssertEqual(try sandbox.files.read(bookmark: bookmark, relPath: "sub/file.txt", maxBytes: 100).data, Data("real".utf8))

        try FileManager.default.moveItem(atPath: sandbox.home + "/Projects/sub", toPath: sandbox.home + "/sub-moved")
        try FileManager.default.createSymbolicLink(atPath: sandbox.home + "/Projects/sub", withDestinationPath: sandbox.home + "/Outside")
        try sandbox.write("Outside/file.txt", "attacker controlled")
        assertBridgeError(.symlink) { try sandbox.files.read(bookmark: bookmark, relPath: "sub/file.txt", maxBytes: 100) }
    }

    func testScopeRootSwappedForSymlink() throws {
        try FileManager.default.moveItem(atPath: sandbox.home + "/Projects", toPath: sandbox.home + "/Projects-moved")
        try FileManager.default.createSymbolicLink(atPath: sandbox.home + "/Projects", withDestinationPath: sandbox.home + "/Outside")
        // The bookmark tracks the original folder's identity, never the impostor symlink's target.
        let info = try sandbox.files.resolveScope(bookmark: bookmark)
        XCTAssertEqual(info.canonicalPath, sandbox.home + "/Projects-moved")
        let read = try sandbox.files.read(bookmark: bookmark, relPath: "readme.txt", maxBytes: 100)
        XCTAssertEqual(read.data, Data("inside".utf8))
    }

    func testHardLinksRejected() throws {
        try FileManager.default.linkItem(atPath: sandbox.home + "/Outside/secret.txt", toPath: sandbox.home + "/Projects/hl.txt")
        assertBridgeError(.hardlink) { try sandbox.files.read(bookmark: bookmark, relPath: "hl.txt", maxBytes: 100) }
        assertBridgeError(.hardlink) {
            try sandbox.files.write(bookmark: bookmark, relPath: "hl.txt", data: Data("x".utf8),
                                    expectedSha256: sha256("outside secret"))
        }
        let stat = try sandbox.files.stat(bookmark: bookmark, relPath: "hl.txt")
        XCTAssertEqual(stat.nlink, 2)
        XCTAssertNil(stat.sha256)
        XCTAssertEqual(try sandbox.read("Outside/secret.txt"), "outside secret")
        XCTAssertEqual(try sandbox.tempFiles(in: "Projects"), [])
    }

    func testProtectedNamesInPathsAndListings() throws {
        try sandbox.write("Projects/.ssh/id_ed25519", "key")
        try sandbox.write("Projects/.env", "A=1")
        try sandbox.write("Projects/.env.local", "A=1")
        try sandbox.write("Projects/x.pem", "pem")
        try sandbox.write("Projects/id_rsa.pub", "pub")
        try sandbox.write("Projects/Login Data", "db")
        try sandbox.write("Projects/vault.KDBX", "db")
        try sandbox.write("Projects/sub/.Env", "A=1")
        try sandbox.write("Projects/environment.txt", "fine")

        for relPath in [".ssh/id_ed25519", ".ssh", ".env", ".ENV.local", "x.pem", "id_rsa.pub", "login data", "sub/.env",
                        "vault.kdbx", ".aws/credentials"] {
            assertBridgeError(.protected) { try sandbox.files.read(bookmark: bookmark, relPath: relPath, maxBytes: 100) }
        }
        assertBridgeError(.protected) {
            try sandbox.files.write(bookmark: bookmark, relPath: "new.key", data: Data(), expectedSha256: nil)
        }
        assertBridgeError(.protected) { try sandbox.files.list(bookmark: bookmark, relPath: ".ssh", limit: 10, cursor: nil) }

        let names = try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 500, cursor: nil).entries.map(\.name)
        XCTAssertEqual(names, ["environment.txt", "readme.txt", "sub"])
        XCTAssertEqual(try sandbox.files.list(bookmark: bookmark, relPath: "sub", limit: 10, cursor: nil).entries, [])
    }
}

final class FileOperationTests: XCTestCase {
    var sandbox: Sandbox!
    var bookmark: String!

    override func setUpWithError() throws {
        sandbox = try Sandbox()
        try sandbox.mkdir("Projects")
        bookmark = try sandbox.scope("Projects")
    }

    func testListPaginationIsStableAndComplete() throws {
        for index in (0..<25).reversed() { try sandbox.write(String(format: "Projects/f%02d.txt", index), "\(index)") }
        try sandbox.mkdir("Projects/dir")
        try FileManager.default.createSymbolicLink(atPath: sandbox.home + "/Projects/zlink", withDestinationPath: "/etc")

        var seen: [ListEntry] = []
        var cursor: String?
        var pages = 0
        repeat {
            let page = try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 10, cursor: cursor)
            seen += page.entries
            cursor = page.nextCursor
            pages += 1
            if pages == 1 {
                // A file added behind the cursor must not shift later pages or cause duplicates.
                try sandbox.write("Projects/a-new.txt", "late")
            }
        } while cursor != nil
        XCTAssertEqual(pages, 3)
        let names = seen.map(\.name)
        XCTAssertEqual(names, ["dir"] + (0..<25).map { String(format: "f%02d.txt", $0) } + ["zlink"])
        XCTAssertEqual(seen.first?.kind, "dir")
        XCTAssertEqual(seen.last?.kind, "symlink")
        XCTAssertEqual(seen[1].kind, "file")
        XCTAssertEqual(seen[1].size, 1)

        // The same cursor always yields the same next page.
        let first = try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 5, cursor: nil)
        let again = try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 5, cursor: first.nextCursor)
        let repeated = try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 5, cursor: first.nextCursor)
        XCTAssertEqual(again, repeated)
    }

    func testListValidation() throws {
        try sandbox.write("Projects/a.txt", "a")
        assertBridgeError(.invalidParams) { try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 0, cursor: nil) }
        assertBridgeError(.invalidParams) { try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 501, cursor: nil) }
        assertBridgeError(.invalidParams) { try sandbox.files.list(bookmark: bookmark, relPath: "", limit: 5, cursor: "bogus!") }
        assertBridgeError(.notADirectory) { try sandbox.files.list(bookmark: bookmark, relPath: "a.txt", limit: 5, cursor: nil) }
        assertBridgeError(.notFound) { try sandbox.files.list(bookmark: bookmark, relPath: "missing", limit: 5, cursor: nil) }
    }

    func testReadTruncationAndHash() throws {
        let content = String(repeating: "0123456789", count: 10)
        try sandbox.write("Projects/data.txt", content)
        let read = try sandbox.files.read(bookmark: bookmark, relPath: "data.txt", maxBytes: 10)
        XCTAssertEqual(read.data, Data("0123456789".utf8))
        XCTAssertTrue(read.truncated)
        XCTAssertEqual(read.size, 100)
        XCTAssertEqual(read.sha256, sha256(content))

        let full = try sandbox.files.read(bookmark: bookmark, relPath: "data.txt", maxBytes: 100)
        XCTAssertFalse(full.truncated)
        XCTAssertEqual(full.data.count, 100)

        let stat = try sandbox.files.stat(bookmark: bookmark, relPath: "data.txt")
        XCTAssertEqual(stat.kind, "file")
        XCTAssertEqual(stat.sha256, sha256(content))
        XCTAssertEqual(stat.nlink, 1)
        XCTAssertEqual(try sandbox.files.stat(bookmark: bookmark, relPath: "").kind, "dir")
    }

    func testReadRejectsNonFilesAndBadLimits() throws {
        try sandbox.mkdir("Projects/dir")
        try sandbox.write("Projects/a.txt", "a")
        XCTAssertEqual(mkfifo(sandbox.home + "/Projects/fifo", 0o600), 0)
        assertBridgeError(.notAFile) { try sandbox.files.read(bookmark: bookmark, relPath: "dir", maxBytes: 10) }
        assertBridgeError(.notAFile) { try sandbox.files.read(bookmark: bookmark, relPath: "", maxBytes: 10) }
        assertBridgeError(.notAFile) { try sandbox.files.read(bookmark: bookmark, relPath: "fifo", maxBytes: 10) }
        XCTAssertEqual(try sandbox.files.stat(bookmark: bookmark, relPath: "fifo").kind, "other")
        assertBridgeError(.notFound) { try sandbox.files.read(bookmark: bookmark, relPath: "missing", maxBytes: 10) }
        assertBridgeError(.notADirectory) { try sandbox.files.read(bookmark: bookmark, relPath: "a.txt/x", maxBytes: 10) }
        assertBridgeError(.invalidParams) { try sandbox.files.read(bookmark: bookmark, relPath: "a.txt", maxBytes: 0) }
        assertBridgeError(.invalidParams) {
            try sandbox.files.read(bookmark: bookmark, relPath: "a.txt", maxBytes: ScopedFiles.maxFileBytes + 1)
        }
    }

    func testFilesOverTheHashLimit() throws {
        let path = sandbox.home + "/Projects/big.bin"
        XCTAssertTrue(FileManager.default.createFile(atPath: path, contents: nil))
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        try handle.truncate(atOffset: UInt64(ScopedFiles.maxFileBytes + 1))
        try handle.close()

        let read = try sandbox.files.read(bookmark: bookmark, relPath: "big.bin", maxBytes: 16)
        XCTAssertEqual(read.data.count, 16)
        XCTAssertTrue(read.truncated)
        XCTAssertNil(read.sha256)
        XCTAssertEqual(read.size, Int64(ScopedFiles.maxFileBytes + 1))
        XCTAssertNil(try sandbox.files.stat(bookmark: bookmark, relPath: "big.bin").sha256)
    }

    func testWriteCreate() throws {
        let result = try sandbox.files.write(bookmark: bookmark, relPath: "new.txt", data: Data("one".utf8), expectedSha256: nil)
        XCTAssertEqual(result.sha256, sha256("one"))
        XCTAssertEqual(result.size, 3)
        XCTAssertEqual(try sandbox.read("Projects/new.txt"), "one")
        let mode = try FileManager.default.attributesOfItem(atPath: sandbox.home + "/Projects/new.txt")[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o644)

        assertBridgeError(.exists) {
            try sandbox.files.write(bookmark: bookmark, relPath: "new.txt", data: Data("two".utf8), expectedSha256: nil)
        }
        XCTAssertEqual(try sandbox.read("Projects/new.txt"), "one")

        assertBridgeError(.notFound) {
            try sandbox.files.write(bookmark: bookmark, relPath: "nodir/x.txt", data: Data(), expectedSha256: nil)
        }
        try sandbox.mkdir("Projects/sub")
        XCTAssertNoThrow(try sandbox.files.write(bookmark: bookmark, relPath: "sub/x.txt", data: Data(), expectedSha256: nil))
        assertBridgeError(.notAFile) { try sandbox.files.write(bookmark: bookmark, relPath: "", data: Data(), expectedSha256: nil) }
        XCTAssertEqual(try sandbox.tempFiles(in: "Projects"), [])
    }

    func testWriteReplace() throws {
        try sandbox.write("Projects/doc.txt", "v1")
        let path = sandbox.home + "/Projects/doc.txt"
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)

        assertBridgeError(.conflict) {
            try sandbox.files.write(bookmark: bookmark, relPath: "doc.txt", data: Data("v2".utf8), expectedSha256: sha256("v0"))
        }
        XCTAssertEqual(try sandbox.read("Projects/doc.txt"), "v1")

        let result = try sandbox.files.write(bookmark: bookmark, relPath: "doc.txt", data: Data("v2".utf8), expectedSha256: sha256("v1"))
        XCTAssertEqual(result.sha256, sha256("v2"))
        XCTAssertEqual(try sandbox.read("Projects/doc.txt"), "v2")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int, 0o600)

        assertBridgeError(.conflict) {
            try sandbox.files.write(bookmark: bookmark, relPath: "missing.txt", data: Data(), expectedSha256: sha256("v1"))
        }
        try sandbox.mkdir("Projects/folder")
        assertBridgeError(.notAFile) {
            try sandbox.files.write(bookmark: bookmark, relPath: "folder", data: Data(), expectedSha256: sha256("v1"))
        }
        XCTAssertEqual(try sandbox.tempFiles(in: "Projects"), [])
    }

    func testWriteSizeLimit() throws {
        assertBridgeError(.tooLarge) {
            try sandbox.files.write(bookmark: bookmark, relPath: "huge.bin", data: Data(count: ScopedFiles.maxFileBytes + 1),
                                    expectedSha256: nil)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: sandbox.home + "/Projects/huge.bin"))
        let max = try sandbox.files.write(bookmark: bookmark, relPath: "max.bin", data: Data(count: ScopedFiles.maxFileBytes),
                                          expectedSha256: nil)
        XCTAssertEqual(max.size, Int64(ScopedFiles.maxFileBytes))
        XCTAssertEqual(try sandbox.tempFiles(in: "Projects"), [])
    }

    func testFailedTempCreationLeavesNothingBehind() throws {
        try sandbox.mkdir("Projects/locked")
        let locked = sandbox.home + "/Projects/locked"
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked) }
        assertBridgeError(.io) {
            try sandbox.files.write(bookmark: bookmark, relPath: "locked/x.txt", data: Data("x".utf8), expectedSha256: nil)
        }
        XCTAssertEqual(try sandbox.tempFiles(in: "Projects/locked"), [])
    }

    func testSingleFileScope() throws {
        try sandbox.write("Docs/plan.txt", "draft")
        let fileScope = try sandbox.scope("Docs/plan.txt")

        XCTAssertEqual(try sandbox.files.read(bookmark: fileScope, relPath: "", maxBytes: 100).data, Data("draft".utf8))
        XCTAssertEqual(try sandbox.files.stat(bookmark: fileScope, relPath: "").sha256, sha256("draft"))
        assertBridgeError(.invalidPath) { try sandbox.files.read(bookmark: fileScope, relPath: "plan.txt", maxBytes: 100) }
        assertBridgeError(.notADirectory) { try sandbox.files.list(bookmark: fileScope, relPath: "", limit: 10, cursor: nil) }
        assertBridgeError(.exists) {
            try sandbox.files.write(bookmark: fileScope, relPath: "", data: Data("x".utf8), expectedSha256: nil)
        }
        let written = try sandbox.files.write(bookmark: fileScope, relPath: "", data: Data("final".utf8),
                                              expectedSha256: sha256("draft"))
        XCTAssertEqual(written.sha256, sha256("final"))
        XCTAssertEqual(try sandbox.read("Docs/plan.txt"), "final")
        XCTAssertEqual(try sandbox.tempFiles(in: "Docs"), [])

        // An atomic replace gives the file a new identity; the bookmark falls back to its path and
        // reports stale so the caller can refresh it. It never widens to the containing directory.
        let info = try sandbox.files.resolveScope(bookmark: fileScope)
        XCTAssertEqual(info.kind, .file)
        XCTAssertEqual(info.canonicalPath, sandbox.home + "/Docs/plan.txt")
        XCTAssertTrue(info.stale)
    }
}
