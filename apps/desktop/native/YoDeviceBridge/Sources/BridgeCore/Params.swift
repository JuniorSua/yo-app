import Foundation

/// Strict accessor for a request's `params` object. Every key must be consumed, so an unknown
/// or misspelled parameter is rejected rather than silently ignored.
struct Params {
    private let values: [String: JSONValue]
    private var consumed: Set<String> = []

    init(_ value: JSONValue?) throws(BridgeError) {
        switch value {
        case nil: values = [:]
        case .object(let dict): values = dict
        default: throw BridgeError.invalidParams("params must be an object")
        }
    }

    mutating func string(_ key: String, maxBytes: Int = 64 * 1024 * 1024) throws(BridgeError) -> String {
        consumed.insert(key)
        guard case .string(let value) = values[key] else { throw BridgeError.invalidParams("\(key) must be a string") }
        guard value.utf8.count <= maxBytes else { throw BridgeError.invalidParams("\(key) is too long") }
        return value
    }

    /// A string that may be absent (taking `defaultValue`) but, when present, must be a string (not null).
    mutating func string(_ key: String, default defaultValue: String, maxBytes: Int) throws(BridgeError) -> String {
        guard values[key] != nil else {
            consumed.insert(key)
            return defaultValue
        }
        return try string(key, maxBytes: maxBytes)
    }

    /// A key that may be absent, or explicitly null, or a string.
    mutating func optionalString(_ key: String, required: Bool = false, maxBytes: Int = 4096) throws(BridgeError)
        -> String?
    {
        consumed.insert(key)
        switch values[key] {
        case nil where required: throw BridgeError.invalidParams("\(key) is required")
        case nil, .null?: return nil
        case .string(let value)?:
            guard value.utf8.count <= maxBytes else { throw BridgeError.invalidParams("\(key) is too long") }
            return value
        default: throw BridgeError.invalidParams("\(key) must be a string or null")
        }
    }

    mutating func int(_ key: String, default defaultValue: Int? = nil) throws(BridgeError) -> Int {
        consumed.insert(key)
        switch values[key] {
        case nil:
            guard let defaultValue else { throw BridgeError.invalidParams("\(key) is required") }
            return defaultValue
        case .int(let value)?:
            guard let narrowed = Int(exactly: value) else { throw BridgeError.invalidParams("\(key) is out of range") }
            return narrowed
        default:
            throw BridgeError.invalidParams("\(key) must be an integer")
        }
    }

    /// A JSON integer that is not a boolean or float. `default` makes the key optional.
    mutating func int64(_ key: String, default defaultValue: Int64? = nil) throws(BridgeError) -> Int64 {
        consumed.insert(key)
        switch values[key] {
        case nil:
            guard let defaultValue else { throw BridgeError.invalidParams("\(key) is required") }
            return defaultValue
        case .int(let value)?: return value
        default: throw BridgeError.invalidParams("\(key) must be an integer")
        }
    }

    /// An integer or null. With `required`, the key must be present even when null.
    mutating func optionalInt64(_ key: String, required: Bool = false) throws(BridgeError) -> Int64? {
        consumed.insert(key)
        switch values[key] {
        case nil where required: throw BridgeError.invalidParams("\(key) is required")
        case nil, .null?: return nil
        case .int(let value)?: return value
        default: throw BridgeError.invalidParams("\(key) must be an integer or null")
        }
    }

    mutating func bool(_ key: String, default defaultValue: Bool? = nil) throws(BridgeError) -> Bool {
        consumed.insert(key)
        switch values[key] {
        case nil:
            guard let defaultValue else { throw BridgeError.invalidParams("\(key) is required") }
            return defaultValue
        case .bool(let value)?: return value
        default: throw BridgeError.invalidParams("\(key) must be a boolean")
        }
    }

    /// An array of strings or null (absent = null). Duplicates are removed, order is kept.
    mutating func optionalStringArray(_ key: String, maxCount: Int, maxBytes: Int) throws(BridgeError) -> [String]? {
        consumed.insert(key)
        switch values[key] {
        case nil, .null?: return nil
        case .array(let items)?:
            guard !items.isEmpty else { throw BridgeError.invalidParams("\(key) must not be empty (use null for all)") }
            guard items.count <= maxCount else { throw BridgeError.invalidParams("\(key) has too many entries") }
            var result: [String] = []
            for item in items {
                guard case .string(let value) = item, !value.isEmpty else {
                    throw BridgeError.invalidParams("\(key) entries must be non-empty strings")
                }
                guard value.utf8.count <= maxBytes else { throw BridgeError.invalidParams("\(key) entry is too long") }
                if !result.contains(value) { result.append(value) }
            }
            return result
        default: throw BridgeError.invalidParams("\(key) must be an array of strings or null")
        }
    }

    /// A finite JSON number (integer or float, never a boolean or string).
    mutating func number(_ key: String) throws(BridgeError) -> Double {
        consumed.insert(key)
        switch values[key] {
        case nil: throw BridgeError.invalidParams("\(key) is required")
        case .int(let value)?: return Double(value)
        case .double(let value)? where value.isFinite: return value
        default: throw BridgeError.invalidParams("\(key) must be a number")
        }
    }

    /// An array of non-empty strings with `minCount...maxCount` entries. Order and duplicates are kept.
    /// `default` makes the key optional (absent only; `null` is rejected).
    mutating func stringArray(_ key: String, default defaultValue: [String]? = nil, minCount: Int, maxCount: Int, maxBytes: Int)
        throws(BridgeError) -> [String]
    {
        consumed.insert(key)
        let items: [JSONValue]
        switch values[key] {
        case nil:
            guard let defaultValue else { throw BridgeError.invalidParams("\(key) is required") }
            return defaultValue
        case .array(let array)?: items = array
        default: throw BridgeError.invalidParams("\(key) must be an array of strings")
        }
        guard items.count >= minCount else { throw BridgeError.invalidParams("\(key) has too few entries") }
        guard items.count <= maxCount else { throw BridgeError.invalidParams("\(key) has too many entries") }
        var result: [String] = []
        for item in items {
            guard case .string(let value) = item, !value.isEmpty else {
                throw BridgeError.invalidParams("\(key) entries must be non-empty strings")
            }
            guard value.utf8.count <= maxBytes else { throw BridgeError.invalidParams("\(key) entry is too long") }
            result.append(value)
        }
        return result
    }

    /// A required nested object, validated with the same strictness as the top level.
    mutating func object(_ key: String) throws(BridgeError) -> Params {
        consumed.insert(key)
        guard case .object? = values[key] else { throw BridgeError.invalidParams("\(key) must be an object") }
        return try Params(values[key])
    }

    var isEmpty: Bool { values.isEmpty }

    /// Value of a key that may be absent but, when present, must not be null.
    mutating func presentValue(_ key: String) throws(BridgeError) -> JSONValue? {
        consumed.insert(key)
        guard let value = values[key] else { return nil }
        if value == .null { throw BridgeError.invalidParams("\(key) must not be null") }
        return value
    }

    /// Distinguishes absent (`nil`), explicit null (`.some(nil)`) and a string.
    mutating func nullableStringIfPresent(_ key: String, maxBytes: Int) throws(BridgeError) -> String?? {
        consumed.insert(key)
        switch values[key] {
        case nil: return nil
        case .null?: return .some(nil)
        case .string(let value)?:
            guard value.utf8.count <= maxBytes else { throw BridgeError.invalidParams("\(key) is too long") }
            return .some(value)
        default: throw BridgeError.invalidParams("\(key) must be a string or null")
        }
    }

    func finish() throws(BridgeError) {
        if values.keys.contains(where: { !consumed.contains($0) }) {
            throw BridgeError.invalidParams("unknown parameter")
        }
    }
}
