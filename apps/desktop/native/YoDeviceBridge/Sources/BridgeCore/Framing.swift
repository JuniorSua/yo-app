import Foundation

public enum FrameError: Error, Equatable {
    /// The peer declared a frame larger than `Framing.maxFrameBytes`.
    case tooLarge(UInt32)
    /// Input ended in the middle of a frame.
    case truncated
}

/// Wire framing: a 4-byte big-endian unsigned length followed by that many bytes of UTF-8 JSON.
public enum Framing {
    public static let maxFrameBytes = 32 * 1024 * 1024

    public static func encode(_ payload: Data) throws -> Data {
        guard payload.count <= maxFrameBytes else { throw FrameError.tooLarge(UInt32(clamping: payload.count)) }
        let length = UInt32(payload.count)
        var frame = Data(capacity: 4 + payload.count)
        frame.append(UInt8(truncatingIfNeeded: length >> 24))
        frame.append(UInt8(truncatingIfNeeded: length >> 16))
        frame.append(UInt8(truncatingIfNeeded: length >> 8))
        frame.append(UInt8(truncatingIfNeeded: length))
        frame.append(payload)
        return frame
    }
}

/// Incremental decoder; feed it whatever `read(2)` returns.
public struct FrameDecoder {
    private var buffer = Data()

    public init() {}

    public var hasPartialFrame: Bool { !buffer.isEmpty }

    /// Appends bytes and returns every complete frame. Throws as soon as a header
    /// declares an oversized frame, before any of its body is buffered.
    public mutating func push(_ bytes: Data) throws -> [Data] {
        buffer.append(bytes)
        var frames: [Data] = []
        var offset = buffer.startIndex
        while buffer.endIndex - offset >= 4 {
            let length =
                UInt32(buffer[offset]) << 24 | UInt32(buffer[offset + 1]) << 16
                | UInt32(buffer[offset + 2]) << 8 | UInt32(buffer[offset + 3])
            guard length <= Framing.maxFrameBytes else {
                buffer.removeAll()
                throw FrameError.tooLarge(length)
            }
            let bodyStart = offset + 4
            guard buffer.endIndex - bodyStart >= Int(length) else { break }
            frames.append(Data(buffer[bodyStart..<bodyStart + Int(length)]))
            offset = bodyStart + Int(length)
        }
        if offset != buffer.startIndex {
            buffer = Data(buffer[offset...])
        }
        return frames
    }

    /// Call at end of input: a clean EOF is fine, a half-received frame is not.
    public func finish() throws {
        if hasPartialFrame { throw FrameError.truncated }
    }
}
