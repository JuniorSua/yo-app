import ApplicationServices
import Contacts
import CoreGraphics
import EventKit

/// OS privacy state in the protocol's status words.
public enum AccessStatus: String, Sendable {
    case notRequested = "not-requested"
    case denied
    case restricted
    case granted
    case limited
    case writeOnly = "write-only"
    case unknown
}

/// Reads OS privacy state using only non-prompting status APIs. Nothing here may ever request access.
public enum Permissions {
    public static func status() -> [String: String] {
        [
            "contacts": contacts().rawValue,
            "calendars": eventKit(.event).rawValue,
            "reminders": eventKit(.reminder).rawValue,
            // AXIsProcessTrusted cannot distinguish "denied" from "never asked".
            "accessibility": AXIsProcessTrusted() ? "granted" : "not-requested",
            // Likewise, CGPreflightScreenCaptureAccess only reports whether access is currently granted.
            "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "not-requested",
        ]
    }

    static func contacts() -> AccessStatus {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .notDetermined: return .notRequested
        case .restricted: return .restricted
        case .denied: return .denied
        case .authorized: return .granted
        case .limited: return .limited
        @unknown default: return .unknown
        }
    }

    static func eventKit(_ type: EKEntityType) -> AccessStatus {
        switch EKEventStore.authorizationStatus(for: type) {
        case .notDetermined: return .notRequested
        case .restricted: return .restricted
        case .denied: return .denied
        case .fullAccess: return .granted
        case .writeOnly: return .writeOnly
        @unknown default: return .unknown
        }
    }
}
