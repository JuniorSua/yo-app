import CryptoKit
import Foundation
import Testing
@testable import YoPhoneKit

/// phone/test/vector.json is the canonical test vector shared by the PWA, the core and this app.
struct Vector: Decodable {
    let secret, authToken, box, dir, aad, iv, plaintextJson, envelope: String
    let registerKey, admit, coreCred, signSeedHex, signPub, sigMessage, sig, link: String

    static let bundled: Data = {
        let url = Bundle.module.url(forResource: "vector", withExtension: "json")!
        return try! Data(contentsOf: url)
    }()

    static let shared = try! JSONDecoder().decode(Vector.self, from: bundled)

    /// The repo's copy: apps/ios/YoPhoneKit/Tests/YoPhoneKitTests/<this file> → repo root is six levels up.
    static let canonicalURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "phone/test/vector.json")
}

private let v = Vector.shared

@Suite("Test vector (shared with phone/lib/crypto.js and apps/core phoneCrypto.ts)")
struct VectorTests {
    @Test func bundledVectorMatchesTheCanonicalFile() throws {
        let canonical = try Data(contentsOf: Vector.canonicalURL)
        #expect(canonical == Vector.bundled, "Copy phone/test/vector.json into Tests/YoPhoneKitTests/Resources/")
    }

    @Test func secretIsBytesZeroToThirtyOne() {
        #expect(Base64URL.decode(v.secret) == Data(0..<32))
    }

    @Test func derivesTheAuthTokenAndBox() throws {
        let keys = try PhoneKeys(secret: v.secret)
        #expect(keys.authToken == v.authToken)
        #expect(keys.box == v.box)
    }

    @Test func messageJSONMatchesJavaScriptByteForByte() {
        let msg = InMessage.msg(id: "vector-1", text: "Yo, café at 5? 👋", at: Date(millis: 1_767_225_600_000))
        #expect(msg.json.serialized() == v.plaintextJson)
    }

    @Test func sealsTheFixedEnvelopeWithTheFixedIV() throws {
        let keys = try PhoneKeys(secret: v.secret)
        #expect(v.dir == "in" && v.aad == "yo-phone/v1/in")
        let envelope = try keys.seal(Data(v.plaintextJson.utf8), .in, iv: Base64URL.decode(v.iv))
        #expect(envelope == v.envelope)
    }

    @Test func opensTheFixedEnvelope() throws {
        let keys = try PhoneKeys(secret: v.secret)
        let plaintext = try keys.open(v.envelope, .in)
        #expect(String(decoding: plaintext, as: UTF8.self) == v.plaintextJson)
    }

    @Test func refusesTheOtherDirectionAnotherKeyOrATamperedEnvelope() throws {
        let keys = try PhoneKeys(secret: v.secret)
        #expect(throws: (any Error).self) { try keys.open(v.envelope, .out) }
        let other = try PhoneKeys(secret: Base64URL.encode(Data(repeating: 7, count: 32)))
        #expect(throws: (any Error).self) { try other.open(v.envelope, .in) }
        var bytes = Base64URL.decode(v.envelope)!
        bytes[bytes.count - 1] ^= 1
        #expect(throws: (any Error).self) { try keys.open(Base64URL.encode(bytes), .in) }
        #expect(throws: (any Error).self) { try keys.open("AAAA", .in) }
    }

    @Test func linkAdmitAndCoreCredAreTheRelayHMACs() throws {
        // The phone never computes these; checking them here proves the vector's link is the one the relay admits.
        func hmac(_ message: String) -> String {
            let key = SymmetricKey(data: Data(v.registerKey.utf8))
            return Base64URL.encode(Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)))
        }
        #expect(hmac("yo-phone/v1/admit\n\(v.box)") == v.admit)
        #expect(hmac("yo-phone/v1/core\n\(v.box)") == v.coreCred)
    }

    @Test func signPubIsThePublicHalfOfTheFixedSeed() throws {
        let seed = Data(stride(from: 0, to: v.signSeedHex.count, by: 2).map {
            let start = v.signSeedHex.index(v.signSeedHex.startIndex, offsetBy: $0)
            return UInt8(v.signSeedHex[start..<v.signSeedHex.index(start, offsetBy: 2)], radix: 16)!
        })
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        #expect(Base64URL.encode(key.publicKey.rawRepresentation) == v.signPub)
    }

    @Test func verifiesTheVectorSignature() throws {
        #expect(String(decoding: ReplyVerifier.message(for: v.envelope), as: UTF8.self) == v.sigMessage)
        let verifier = try #require(ReplyVerifier(signPub: v.signPub))
        #expect(verifier.verify(envelope: v.envelope, sig: v.sig))
    }

    @Test func rejectsTamperedMissingOrForeignSignatures() throws {
        let verifier = try #require(ReplyVerifier(signPub: v.signPub))
        let env = v.envelope
        let i = env.index(env.startIndex, offsetBy: 20)
        let flipped = env.replacingCharacters(in: i...i, with: env[i] == "A" ? "B" : "A")
        #expect(!verifier.verify(envelope: flipped, sig: v.sig))
        var sigBytes = Base64URL.decode(v.sig)!
        sigBytes[10] ^= 1
        #expect(!verifier.verify(envelope: env, sig: Base64URL.encode(sigBytes)))
        for bad in [nil, "", "abc", String(v.sig.dropLast(2)), v.sig + "AA"] {
            #expect(!verifier.verify(envelope: env, sig: bad))
        }
        let other = Curve25519.Signing.PrivateKey()
        let otherVerifier = try #require(ReplyVerifier(signPub: Base64URL.encode(other.publicKey.rawRepresentation)))
        #expect(!otherVerifier.verify(envelope: env, sig: v.sig))
        let foreignSig = try other.signature(for: ReplyVerifier.message(for: env))
        #expect(!verifier.verify(envelope: env, sig: Base64URL.encode(foreignSig)))
    }

    @Test func rejectsMalformedPublicKeys() {
        #expect(ReplyVerifier(signPub: "not-a-key") == nil)
        #expect(ReplyVerifier(signPub: Base64URL.encode(Data(count: 31))) == nil)
    }

    @Test func theVectorLinkParses() {
        let parsed = PhoneLink.parse(v.link)
        #expect(parsed == .link(PhoneLink(secret: v.secret, admit: v.admit, signPub: v.signPub)))
    }
}

@Suite struct Base64URLTests {
    @Test func roundTripsEveryLengthWithoutPadding() {
        for n in 0..<40 {
            let bytes = Data((0..<n).map { UInt8(($0 * 37 + n) & 255) })
            let s = Base64URL.encode(bytes)
            #expect(!s.contains(where: { "+/=".contains($0) }))
            #expect(Base64URL.decode(s) == bytes)
        }
    }

    @Test func rejectsNonBase64URL() {
        #expect(Base64URL.decode("abc+") == nil)
        #expect(Base64URL.decode("a") == nil)
        #expect(Base64URL.isValid("ab_-"))
        #expect(!Base64URL.isValid("ab/="))
    }

    @Test func messageIDsAreDistinct() {
        let id = randomMessageID()
        #expect(id.count == 16)
        #expect(randomMessageID() != id)
    }

    @Test func randomEnvelopesRoundTripBothWays() throws {
        let keys = try PhoneKeys(secret: Base64URL.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }))
        let plaintext = Data(String(repeating: "héllo 👋 ", count: 50).utf8)
        for dir in [Direction.in, .out] {
            let a = try keys.seal(plaintext, dir)
            let b = try keys.seal(plaintext, dir)
            #expect(a != b)
            #expect(try keys.open(a, dir) == plaintext)
        }
        #expect(throws: PhoneCryptoError.badSecret) { try PhoneKeys(secret: Base64URL.encode(Data(count: 16))) }
    }
}
