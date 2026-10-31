import CryptoKit
import Foundation
import XCTest

@testable import BridgeCore

/// A throwaway fake home directory, so home-relative protections never touch the real one.
final class Sandbox {
    let base: String
    let home: String
    let config: BridgeConfig
    let files: ScopedFiles

    init() throws {
        let raw = (NSTemporaryDirectory() as NSString).appendingPathComponent("yo-bridge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: raw, withIntermediateDirectories: true)
        base = PathPolicy.realpath(raw)!
        home = base + "/home"
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
        config = try BridgeConfig(homeDirectory: home)
        files = ScopedFiles(config: config)
    }

    deinit { try? FileManager.default.removeItem(atPath: base) }

    @discardableResult
    func mkdir(_ rel: String) throws -> String {
        let path = home + "/" + rel
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    @discardableResult
    func write(_ rel: String, _ contents: String) throws -> String {
        let path = home + "/" + rel
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }

    func read(_ rel: String) throws -> String {
        try String(contentsOfFile: home + "/" + rel, encoding: .utf8)
    }

    func scope(_ rel: String) throws -> String {
        try files.createScope(path: home + "/" + rel).bookmark
    }

    func tempFiles(in rel: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: home + "/" + rel).filter { $0.hasPrefix(".yo-tmp-") }
    }
}

func sha256(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}

func assertBridgeError<T>(
    _ code: ErrorCode, file: StaticString = #filePath, line: UInt = #line, _ body: () throws -> T
) {
    do {
        _ = try body()
        XCTFail("expected \(code.rawValue), got success", file: file, line: line)
    } catch let error as BridgeError {
        XCTAssertEqual(error.code, code, "message: \(error.message)", file: file, line: line)
    } catch {
        XCTFail("unexpected error \(error)", file: file, line: line)
    }
}

/// A session whose OS backends are all fakes, so no test can reach Contacts, EventKit,
/// Accessibility, Screen Recording, the event taps or Apple Events.
func fakeSession(
    config: BridgeConfig, permissions: @escaping () -> [String: String] = { [:] },
    contacts: FakeContacts = FakeContacts(), calendar: FakeCalendar = FakeCalendar(),
    desktop: FakeDesktop = FakeDesktop(), automation: FakeAutomation = FakeAutomation(), excludedPids: Set<Int32> = []
) -> Session {
    Session(
        config: config, permissions: permissions, contacts: contacts, calendar: calendar, desktop: desktop.backends,
        excludedPids: excludedPids, automation: automation)
}

/// Greets a session and returns it.
func greeted(_ session: Session) throws -> Session {
    let hello: JSONValue = ["type": "hello", "nonce": "00112233445566778899aabbccddeeff", "protocol": 1]
    _ = session.handle(frame: try hello.encoded())
    return session
}
