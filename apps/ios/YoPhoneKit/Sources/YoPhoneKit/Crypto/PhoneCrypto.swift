import CryptoKit
import Foundation

/// Which way an envelope travels. The direction is the AES-GCM additional data, so the relay can't reflect a
/// message back the other way.
public enum Direction: String, Sendable {
    /// phone → core
    case `in`
    /// core → phone
    case out

    var aad: Data { Data("yo-phone/v1/\(rawValue)".utf8) }
}

public enum PhoneCryptoError: Error, Equatable {
    case badSecret
    case badEnvelope
    case badIV
}

/// The keys a phone derives from the 32-byte link secret (docs/phone/PROTOCOL.md, "Keys").
public struct PhoneKeys: Sendable {
    /// Sent as `Authorization: Bearer <authToken>`.
    public let authToken: String
    let encKey: SymmetricKey

    public init(secret: String) throws {
        guard let raw = Base64URL.decode(secret), raw.count == 32 else { throw PhoneCryptoError.badSecret }
        let ikm = SymmetricKey(data: raw)
        func hkdf(_ info: String) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Data(), info: Data(info.utf8), outputByteCount: 32)
        }
        authToken = Base64URL.encode(hkdf("yo-phone/v1/auth").withUnsafeBytes { Data($0) })
        encKey = hkdf("yo-phone/v1/enc")
    }

    /// The mailbox id the relay derives: hex(sha256(utf8(authToken))).
    public var box: String {
        SHA256.hash(data: Data(authToken.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// `base64url(iv[12] || AES-GCM(encKey, iv, plaintext, aad))`. Pass `iv` only in tests.
    public func seal(_ plaintext: Data, _ direction: Direction, iv: Data? = nil) throws -> String {
        let nonce: AES.GCM.Nonce
        if let iv {
            guard iv.count == 12 else { throw PhoneCryptoError.badIV }
            nonce = try AES.GCM.Nonce(data: iv)
        } else {
            nonce = AES.GCM.Nonce()
        }
        let sealed = try AES.GCM.seal(plaintext, using: encKey, nonce: nonce, authenticating: direction.aad)
        guard let combined = sealed.combined else { throw PhoneCryptoError.badEnvelope }
        return Base64URL.encode(combined)
    }

    /// Decrypts an envelope. Throws if it was tampered with, sealed for the other direction, or for another key.
    public func open(_ envelope: String, _ direction: Direction) throws -> Data {
        guard let bytes = Base64URL.decode(envelope), bytes.count >= 12 + 16 else {
            throw PhoneCryptoError.badEnvelope
        }
        let box = try AES.GCM.SealedBox(combined: bytes)
        return try AES.GCM.open(box, using: encKey, authenticating: direction.aad)
    }
}

/// Checks the core's Ed25519 signatures on `out` items: `sig = Ed25519(signKey, "yo-phone/v1/out\n" + envelope)`.
public struct ReplyVerifier: Sendable {
    let key: Curve25519.Signing.PublicKey

    /// `signPub` is the raw 32-byte public key from the link (`p=`), base64url.
    public init?(signPub: String) {
        guard let raw = Base64URL.decode(signPub), raw.count == 32,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
        else { return nil }
        self.key = key
    }

    /// Never throws: anything missing or malformed is just `false`.
    public func verify(envelope: String, sig: String?) -> Bool {
        guard let sig, let sigBytes = Base64URL.decode(sig), sigBytes.count == 64 else { return false }
        return key.isValidSignature(sigBytes, for: Self.message(for: envelope))
    }

    public static func message(for envelope: String) -> Data {
        Data("yo-phone/v1/out\n\(envelope)".utf8)
    }
}

/// A short random id for messages (the core dedupes on it).
public func randomMessageID() -> String {
    Base64URL.encode(SymmetricKey(size: .init(bitCount: 96)).withUnsafeBytes { Data($0) })
}
