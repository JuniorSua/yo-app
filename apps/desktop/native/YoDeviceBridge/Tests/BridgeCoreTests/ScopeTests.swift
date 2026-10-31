import Foundation
import XCTest

@testable import BridgeCore

final class ScopeTests: XCTestCase {
    var sandbox: Sandbox!

    override func setUpWithError() throws { sandbox = try Sandbox() }

    func testCreateDirectoryScope() throws {
        try sandbox.mkdir("Projects/app")
        let (bookmark, info) = try sandbox.files.createScope(path: sandbox.home + "/Projects/app/")
        XCTAssertFalse(bookmark.isEmpty)
        XCTAssertEqual(info.canonicalPath, sandbox.home + "/Projects/app")
        XCTAssertEqual(info.kind, .dir)
        XCTAssertEqual(info.displayPath, "~/Projects/app")
    }

    func testCreateFileScope() throws {
        try sandbox.write("Docs/plan.txt", "x")
        let info = try sandbox.files.createScope(path: sandbox.home + "/Docs/plan.txt").info
        XCTAssertEqual(info.kind, .file)
        XCTAssertEqual(info.displayPath, "~/Docs/plan.txt")
    }

    func testProtectedRoots() throws {
        try sandbox.mkdir("Library/Application Support")
        try sandbox.mkdir(".Trash/old")
        try sandbox.mkdir(".ssh")
        try sandbox.mkdir("Projects/.aws")
        try sandbox.write("Projects/.env", "SECRET=1")
        try sandbox.write("Projects/server.PEM", "k")
        try sandbox.mkdir("library-not-really")
        let home = sandbox.home
        for path in [
            "/", home, home + "/", home + "/Library", home + "/Library/Application Support", home + "/.Trash/old",
            home + "/.ssh", home + "/Projects/.aws", home + "/Projects/.env", home + "/Projects/server.PEM",
            "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/private", "/private/var",
            "/dev", "/opt", "/cores", "/Volumes", sandbox.base,
        ] where FileManager.default.fileExists(atPath: path) {
            assertBridgeError(.protected) { try sandbox.files.createScope(path: path) }
        }
        // Prefix lookalikes are not the protected directory.
        XCTAssertNoThrow(try sandbox.files.createScope(path: home + "/library-not-really"))
    }

    func testCaseInsensitiveLibraryExclusion() throws {
        try sandbox.mkdir("Library/Mail")
        assertBridgeError(.protected) { try sandbox.files.createScope(path: sandbox.home + "/LIBRARY/Mail") }
    }

    func testCreateRejectsBadPaths() throws {
        assertBridgeError(.invalidPath) { try sandbox.files.createScope(path: "Projects") }
        assertBridgeError(.notFound) { try sandbox.files.createScope(path: sandbox.home + "/missing") }
    }

    func testCreateThroughSymlinkUsesCanonicalTarget() throws {
        try sandbox.mkdir("Library/Secrets")
        try FileManager.default.createSymbolicLink(atPath: sandbox.home + "/sneaky", withDestinationPath: sandbox.home + "/Library/Secrets")
        assertBridgeError(.protected) { try sandbox.files.createScope(path: sandbox.home + "/sneaky") }
    }

    func testResolveRoundTrip() throws {
        try sandbox.mkdir("Projects")
        let bookmark = try sandbox.scope("Projects")
        let info = try sandbox.files.resolveScope(bookmark: bookmark)
        XCTAssertEqual(info.canonicalPath, sandbox.home + "/Projects")
        XCTAssertEqual(info.kind, .dir)
    }

    func testResolveFollowsMoveAndRevalidates() throws {
        try sandbox.mkdir("Projects")
        try sandbox.mkdir("Library")
        let bookmark = try sandbox.scope("Projects")
        try FileManager.default.moveItem(atPath: sandbox.home + "/Projects", toPath: sandbox.home + "/Library/Projects")
        assertBridgeError(.protected) { try sandbox.files.resolveScope(bookmark: bookmark) }
    }

    func testResolveDeletedScopeIsStale() throws {
        try sandbox.mkdir("Gone")
        let bookmark = try sandbox.scope("Gone")
        try FileManager.default.removeItem(atPath: sandbox.home + "/Gone")
        assertBridgeError(.staleScope) { try sandbox.files.resolveScope(bookmark: bookmark) }
    }

    func testResolveGarbage() {
        assertBridgeError(.invalidParams) { try sandbox.files.resolveScope(bookmark: "%%%") }
        assertBridgeError(.staleScope) {
            try sandbox.files.resolveScope(bookmark: Data("not a bookmark".utf8).base64EncodedString())
        }
    }
}
