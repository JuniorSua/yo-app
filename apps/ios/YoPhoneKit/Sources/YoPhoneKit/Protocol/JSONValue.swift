import Foundation

/// A small JSON value whose objects keep their key order and serialize exactly like JavaScript's
/// `JSON.stringify`, so a message sealed here is byte-identical to the same message sealed by the PWA.
public indirect enum JSONValue: Equatable, Sendable {
    case string(String)
    case int(Int64)
    case bool(Bool)
    case array([JSONValue])
    case object([(String, JSONValue)])

    public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        lhs.serialized() == rhs.serialized()
    }

    public func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    public var data: Data { Data(serialized().utf8) }

    private func write(to out: inout String) {
        switch self {
        case let .string(s):
            Self.writeString(s, to: &out)
        case let .int(n):
            out += String(n)
        case let .bool(b):
            out += b ? "true" : "false"
        case let .array(items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                item.write(to: &out)
            }
            out += "]"
        case let .object(pairs):
            out += "{"
            for (i, (key, value)) in pairs.enumerated() {
                if i > 0 { out += "," }
                Self.writeString(key, to: &out)
                out += ":"
                value.write(to: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20:
                out += String(format: "\\u%04x", scalar.value)
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }
}
