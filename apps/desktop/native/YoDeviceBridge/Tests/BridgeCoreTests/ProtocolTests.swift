import Foundation
import XCTest

@testable import BridgeCore

final class FramingTests: XCTestCase {
    func testRoundTripAcrossArbitraryChunking() throws {
        let payloads = [Data(#"{"a":1}"#.utf8), Data(), Data(repeating: 0x41, count: 70_000)]
        var stream = Data()
        for payload in payloads { stream.append(try Framing.encode(payload)) }

        var decoder = FrameDecoder()
        var decoded: [Data] = []
        var index = stream.startIndex
        while index < stream.endIndex {
            let end = min(index + 7, stream.endIndex)
            decoded += try decoder.push(Data(stream[index..<end]))
            index = end
        }
        XCTAssertEqual(decoded, payloads)
        XCTAssertNoThrow(try decoder.finish())
    }

    func testHeaderIsBigEndian() throws {
        let frame = try Framing.encode(Data(repeating: 0, count: 0x0102))
        XCTAssertEqual(Array(frame.prefix(4)), [0, 0, 1, 2])
    }

    func testOversizedDeclaredLengthFailsBeforeBody() {
        var decoder = FrameDecoder()
        let length = UInt32(Framing.maxFrameBytes + 1)
        let header = Data([UInt8(length >> 24), UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff)])
        XCTAssertThrowsError(try decoder.push(header)) { XCTAssertEqual($0 as? FrameError, .tooLarge(length)) }
        XCTAssertThrowsError(try Framing.encode(Data(count: Framing.maxFrameBytes + 1)))
    }

    func testMaximumDeclaredLengthIsAccepted() throws {
        var decoder = FrameDecoder()
        let length = UInt32(Framing.maxFrameBytes)
        let header = Data([UInt8(length >> 24), UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff)])
        XCTAssertEqual(try decoder.push(header), [])
    }

    func testTruncatedFrameAtEOF() throws {
        var decoder = FrameDecoder()
        _ = try decoder.push(Data([0, 0, 0, 5, 1, 2]))
        XCTAssertThrowsError(try decoder.finish()) { XCTAssertEqual($0 as? FrameError, .truncated) }
    }
}

final class SessionTests: XCTestCase {
    var sandbox: Sandbox!
    var session: Session!
    let nonce = "00112233445566778899aabbccddeeff"

    override func setUpWithError() throws {
        sandbox = try Sandbox()
        session = fakeSession(config: sandbox.config, permissions: { ["contacts": "granted"] })
    }

    private func send(_ value: JSONValue) throws -> SessionAction {
        session.handle(frame: try value.encoded())
    }

    private func reply(_ value: JSONValue) throws -> JSONValue {
        guard case .reply(let data) = try send(value) else {
            XCTFail("expected a reply")
            return .null
        }
        return try JSONValue.parse(data)
    }

    private func greet() throws {
        _ = try reply(["type": "hello", "nonce": .string(nonce), "protocol": 1])
    }

    private func call(_ method: String, _ params: JSONValue = [:]) throws -> JSONValue {
        try reply(["id": "r1", "method": .string(method), "params": params])
    }

    private func errorCode(_ response: JSONValue) -> String? {
        guard case .string(let code)? = response["error"]?["code"] else { return nil }
        return code
    }

    func testHelloHandshake() throws {
        let response = try reply(["type": "hello", "nonce": .string(nonce), "protocol": 1])
        XCTAssertEqual(response["type"], "hello")
        XCTAssertEqual(response["nonce"], .string(nonce))
        XCTAssertEqual(response["protocol"], 1)
        XCTAssertEqual(response["version"], "0.3.0")
        XCTAssertEqual(response["arch"], .string(Session.arch))
        XCTAssertEqual(response["macos"], .string(ProcessInfo.processInfo.operatingSystemVersionString))
    }

    func testRequestBeforeHelloExits() throws {
        XCTAssertEqual(try send(["id": "1", "method": "status"]), .exit(3))
    }

    func testMalformedHelloExits() throws {
        let bad: [JSONValue] = [
            ["type": "hello", "nonce": .string(nonce), "protocol": 2],
            ["type": "hello", "nonce": "not-hex-not-hex-not-hex", "protocol": 1],
            ["type": "hello", "nonce": "abcd", "protocol": 1],
            ["type": "hello", "nonce": .string(nonce), "protocol": 1, "extra": true],
            ["type": "hello", "nonce": .string(nonce), "protocol": "1"],
        ]
        for message in bad {
            let fresh = fakeSession(config: sandbox.config)
            XCTAssertEqual(fresh.handle(frame: try message.encoded()), .exit(3), "\(message)")
        }
        XCTAssertEqual(session.handle(frame: Data("not json".utf8)), .exit(3))
    }

    func testSecondHelloExits() throws {
        try greet()
        XCTAssertEqual(try send(["type": "hello", "nonce": .string(nonce), "protocol": 1]), .exit(3))
    }

    func testStatusAndPermissions() throws {
        try greet()
        let status = try call("status")
        XCTAssertEqual(status["ok"], true)
        XCTAssertEqual(status["result"]?["version"], "0.3.0")
        XCTAssertEqual(try call("permissions.status")["result"], ["contacts": "granted"])
    }

    func testRealPermissionProbeShape() {
        let allowed: Set = ["not-requested", "denied", "restricted", "granted", "limited", "write-only", "unknown"]
        let status = Permissions.status()
        XCTAssertEqual(Set(status.keys), ["contacts", "calendars", "reminders", "accessibility", "screenRecording"])
        XCTAssertTrue(status.values.allSatisfy(allowed.contains))
    }

    func testUnknownMethodAndStrictParams() throws {
        try greet()
        XCTAssertEqual(errorCode(try call("shell.exec")), "unsupported")
        XCTAssertEqual(errorCode(try call("status", ["verbose": true])), "invalid_params")
        XCTAssertEqual(errorCode(try call("files.list", ["bookmark": "x", "relPath": 1])), "invalid_params")
        XCTAssertEqual(errorCode(try call("files.list", ["bookmark": "x", "relPath": "", "limit": "5"])), "invalid_params")
        XCTAssertEqual(errorCode(try call("files.list", ["bookmark": "x", "relPath": "", "limit": true])), "invalid_params")
        XCTAssertEqual(errorCode(try call("files.list", ["bookmark": "x", "relPath": "", "limit": .double(2.5)])), "invalid_params")
        XCTAssertEqual(errorCode(try call("scope.create", ["path": .null])), "invalid_params")
        XCTAssertEqual(errorCode(try call("status", "not an object")), "invalid_params")
        // expectedSha256 must be present (null for create) so a forgotten field never changes semantics.
        XCTAssertEqual(errorCode(try call("files.write", ["bookmark": "x", "relPath": "a", "dataBase64": ""])), "invalid_params")
        XCTAssertEqual(
            errorCode(try call("files.write", ["bookmark": "x", "relPath": "a", "dataBase64": "", "expectedSha256": "abc"])),
            "invalid_params")
        let extraField = try reply(["id": "r2", "method": "status", "params": [:], "sudo": true])
        XCTAssertEqual(errorCode(extraField), "invalid_params")
    }

    func testMalformedRequestsAfterHello() throws {
        try greet()
        guard case .reply(let data) = session.handle(frame: Data("[1,2]".utf8)) else { return XCTFail() }
        let response = try JSONValue.parse(data)
        XCTAssertEqual(response["id"], .null)
        XCTAssertEqual(errorCode(response), "invalid_params")
        XCTAssertEqual(errorCode(try reply(["id": 5, "method": "status"])), "invalid_params")
    }

    func testEndToEndFileRoundTrip() throws {
        try greet()
        try sandbox.mkdir("Projects")
        let created = try call("scope.create", ["path": .string(sandbox.home + "/Projects")])
        XCTAssertEqual(created["result"]?["displayPath"], "~/Projects")
        XCTAssertEqual(created["result"]?["kind"], "dir")
        guard case .string(let bookmark)? = created["result"]?["bookmark"] else { return XCTFail("no bookmark") }

        let payload = Data("hello bridge".utf8).base64EncodedString()
        let write = try call("files.write", [
            "bookmark": .string(bookmark), "relPath": "note.txt", "dataBase64": .string(payload), "expectedSha256": nil,
        ])
        XCTAssertEqual(write["result"]?["sha256"], .string(sha256("hello bridge")))

        let read = try call("files.read", ["bookmark": .string(bookmark), "relPath": "note.txt", "maxBytes": 1024])
        XCTAssertEqual(read["result"]?["dataBase64"], .string(payload))
        XCTAssertEqual(read["result"]?["truncated"], false)

        let resolved = try call("scope.resolve", ["bookmark": .string(bookmark)])
        XCTAssertEqual(resolved["result"]?["stale"], false)
        XCTAssertEqual(resolved["result"]?["canonicalPath"], .string(sandbox.home + "/Projects"))
    }

    func testOversizedWritePayloadRejected() throws {
        try greet()
        let big = String(repeating: "A", count: (ScopedFiles.maxFileBytes + 2) / 3 * 4 + 4)
        let response = try call("files.write", ["bookmark": "x", "relPath": "a", "dataBase64": .string(big), "expectedSha256": nil])
        XCTAssertEqual(errorCode(response), "too_large")
    }
}
