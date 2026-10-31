import BridgeCore
import Foundation

func log(_ message: String) {
    FileHandle.standardError.write(Data("YoDeviceBridge: \(message)\n".utf8))
}

/// Writes one framed payload to stdout; a closed pipe means the parent is gone.
func send(_ payload: Data) {
    guard let frame = try? Framing.encode(payload) else { exit(ExitCode.framing) }
    var offset = 0
    while offset < frame.count {
        let written = frame.withUnsafeBytes { write(STDOUT_FILENO, $0.baseAddress! + offset, frame.count - offset) }
        if written < 0 {
            if errno == EINTR { continue }
            exit(ExitCode.ok)
        }
        offset += written
    }
}

// Writing to a closed pipe must surface as EPIPE, not kill the process silently mid-frame.
signal(SIGPIPE, SIG_IGN)

let session: Session
do {
    session = Session(config: try BridgeConfig.live())
} catch {
    log("cannot determine home directory")
    exit(1)
}

var decoder = FrameDecoder()
var buffer = [UInt8](repeating: 0, count: 1 << 20)
while true {
    let count = buffer.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
    if count < 0 {
        if errno == EINTR { continue }
        log("stdin read failed")
        exit(ExitCode.framing)
    }
    if count == 0 {
        do {
            try decoder.finish()
            exit(ExitCode.ok)
        } catch {
            log("stdin closed mid-frame")
            exit(ExitCode.framing)
        }
    }
    let frames: [Data]
    do {
        frames = try decoder.push(Data(buffer[0..<count]))
    } catch {
        log("oversized frame")
        send(Session.frameTooLargeError())
        exit(ExitCode.framing)
    }
    for frame in frames {
        switch session.handle(frame: frame) {
        case .reply(let payload): send(payload)
        case .exit(let code):
            log("protocol violation")
            exit(code)
        }
    }
}
