import Foundation

/// A v2 phone link: `https://<relay-host>/#k=<secret>&a=<admit>&p=<signPub>` (docs/phone/PROTOCOL.md, "v2").
public struct PhoneLink: Codable, Equatable, Sendable {
    /// 32 random bytes, base64url. Gives the auth token and the encryption key.
    public let secret: String
    /// The relay's admission credential, sent as `X-Yo-Admit`.
    public let admit: String
    /// The core's raw Ed25519 public key, base64url. Every reply must be signed by it.
    public let signPub: String
    /// The relay's origin, e.g. `https://yo-phone.vercel.app`.
    public let relay: URL

    public static let defaultRelay = URL(string: "https://yo-phone.vercel.app")!

    public static let oldLinkMessage = "This link is from an older version. Ask Yo for a new one."
    public static let badLinkMessage =
        "That doesn't look like a Yo phone link. Copy the whole link from Yo and try again."

    public init(secret: String, admit: String, signPub: String, relay: URL = PhoneLink.defaultRelay) {
        self.secret = secret
        self.admit = admit
        self.signPub = signPub
        self.relay = relay
    }

    public enum Parsed: Equatable, Sendable {
        case link(PhoneLink)
        /// A v1 link (key only): "This link is from an older version."
        case old
        case invalid

        /// What to show the owner when pairing fails, or nil for a usable link.
        public var errorMessage: String? {
            switch self {
            case .link: nil
            case .old: PhoneLink.oldLinkMessage
            case .invalid: PhoneLink.badLinkMessage
            }
        }
    }

    /// Reads whatever the PWA's paste box accepts: the full link, the link inside other text, or just its
    /// fragment. A bare 43-character key or a link without `a` and `p` is a v1 link.
    ///
    /// The relay is the link's origin. Without an origin (a pasted fragment) it's the default relay. Plain
    /// `http` is only accepted for local hosts, and only when `allowInsecureLocalhost` is set (debug builds).
    public static func parse(_ text: String, allowInsecureLocalhost: Bool = false) -> Parsed {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let (k, kRange) = param("k", in: t) else {
            return t.utf16.count == 43 && t.utf8.allSatisfy(Base64URL.isAlphabet) ? .old : .invalid
        }
        guard let (a, _) = param("a", in: t), let (p, _) = param("p", in: t) else { return .old }
        guard ReplyVerifier(signPub: p) != nil, (try? PhoneKeys(secret: k)) != nil else { return .invalid }
        guard let relay = relayOrigin(in: t, around: kRange, allowInsecureLocalhost: allowInsecureLocalhost) else {
            return .invalid
        }
        return .link(PhoneLink(secret: k, admit: a, signPub: p, relay: relay))
    }

    /// The link as Yo shows it.
    public var url: URL {
        URL(string: "\(relay.absoluteString)/#k=\(secret)&a=\(admit)&p=\(signPub)")!
    }

    /// The relay host for display, e.g. `yo-phone.vercel.app` or `localhost:5199`.
    public var relayHost: String {
        guard let host = relay.host() else { return relay.absoluteString }
        return relay.port.map { "\(host):\($0)" } ?? host
    }

    // MARK: - Parsing helpers

    private static func param(_ name: String, in text: String) -> (String, NSRange)? {
        let pattern = "[#&?]\(name)=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])"
        let regex = try! NSRegularExpression(pattern: pattern)
        let ns = text as NSString
        guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        return (ns.substring(with: match.range(at: 1)), match.range)
    }

    private static func relayOrigin(in text: String, around kRange: NSRange, allowInsecureLocalhost: Bool) -> URL? {
        let regex = try! NSRegularExpression(pattern: "[A-Za-z][A-Za-z0-9+.-]*://\\S+")
        let ns = text as NSString
        let token = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
            .first { NSLocationInRange(kRange.location, $0.range) }
            .map { ns.substring(with: $0.range) }
        guard let token else { return defaultRelay }
        guard let parts = URLComponents(string: token), let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty,
              isAllowedRelay(scheme: scheme, host: host, allowInsecureLocalhost: allowInsecureLocalhost)
        else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = parts.port
        return origin.url
    }

    /// Whether this build may use the link's relay: always for https, for plain http only on a local host when
    /// `allowInsecureLocalhost` is set. A link saved by a debug build is checked again before a release build uses it.
    public func usesAllowedRelay(allowInsecureLocalhost: Bool) -> Bool {
        guard let scheme = relay.scheme?.lowercased(), let host = relay.host()?.lowercased() else { return false }
        return Self.isAllowedRelay(scheme: scheme, host: host, allowInsecureLocalhost: allowInsecureLocalhost)
    }

    private static func isAllowedRelay(scheme: String, host: String, allowInsecureLocalhost: Bool) -> Bool {
        scheme == "https" || scheme == "http" && allowInsecureLocalhost && isLocal(host)
    }

    private static func isLocal(_ host: String) -> Bool {
        host == "localhost" || host.hasSuffix(".local")
            || host.split(separator: ".").count == 4 && host.split(separator: ".").allSatisfy { UInt8($0) != nil }
    }
}
