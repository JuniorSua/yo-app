import Foundation

public enum ErrorCode: String, Sendable {
    case invalidParams = "invalid_params"
    case invalidPath = "invalid_path"
    case notFound = "not_found"
    case protected
    case symlink
    case hardlink
    case tooLarge = "too_large"
    case conflict
    case notADirectory = "not_a_directory"
    case notAFile = "not_a_file"
    case exists
    case staleScope = "stale_scope"
    case io
    case unsupported
    /// An OS privacy permission (Contacts, Calendars, Reminders, Accessibility, Screen Recording or
    /// Automation) is not granted.
    case permission
    /// The calendar or reminder list does not allow modifications.
    case readOnly = "read_only"
    /// The window belongs to an app on the deny list (see AppDenyList).
    case denied
    /// Secure keyboard entry is on (a password field has focus) or the screen is locked.
    case secureInput = "secure_input"
    /// The user touched the keyboard or mouse in the last 1.5 s.
    case userActive = "user_active"
    /// The target window could not be brought to, or is no longer, the focused front window at the point.
    case notFrontmost = "not_frontmost"
}

/// Messages are fixed, short strings. They never include file contents and never echo paths.
public struct BridgeError: Error, Equatable, Sendable {
    public let code: ErrorCode
    public let message: String

    public init(_ code: ErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }

    static func invalidParams(_ message: String) -> BridgeError { BridgeError(.invalidParams, message) }

    /// Maps an errno from a descriptor-relative call to a protocol error.
    static func errno(_ value: Int32, _ operation: String) -> BridgeError {
        switch value {
        case ENOENT: return BridgeError(.notFound, "\(operation): no such file or directory")
        case ENOTDIR: return BridgeError(.notADirectory, "\(operation): not a directory")
        case ELOOP, EMLINK: return BridgeError(.symlink, "\(operation): symbolic links are not followed")
        case EISDIR: return BridgeError(.notAFile, "\(operation): is a directory")
        case EEXIST: return BridgeError(.exists, "\(operation): already exists")
        case ENAMETOOLONG: return BridgeError(.invalidPath, "\(operation): name too long")
        case EACCES, EPERM: return BridgeError(.io, "\(operation): permission denied")
        case ENOSPC, EDQUOT: return BridgeError(.io, "\(operation): no space left")
        default: return BridgeError(.io, "\(operation): error \(value)")
        }
    }
}
