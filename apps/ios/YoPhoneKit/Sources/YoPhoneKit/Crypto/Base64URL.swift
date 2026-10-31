import Foundation

/// Base64url without padding, matching `toB64url` / `fromB64url` in phone/lib/crypto.js.
public enum Base64URL {
    public static func encode(_ data: some DataProtocol) -> String {
        Data(data).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Returns nil for anything that isn't strict base64url (the same rule as the PWA: only `A-Z a-z 0-9 - _`,
    /// and a length that isn't 1 more than a multiple of 4).
    public static func decode(_ string: String) -> Data? {
        guard isValid(string) else { return nil }
        var b64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        return Data(base64Encoded: b64)
    }

    public static func isValid(_ string: String) -> Bool {
        string.count % 4 != 1 && string.utf8.allSatisfy(isAlphabet)
    }

    static func isAlphabet(_ c: UInt8) -> Bool {
        switch c {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"):
            true
        default:
            false
        }
    }
}
