import Foundation
import Observation
import UIKit

/// Drive mode, as in the PWA: tap the mic and talk; when you stop talking it counts down 3 seconds and sends,
/// unless you tap to cancel. Yo's replies are read aloud while it's on.
@MainActor
@Observable
final class DriveController {
    enum Phase: Equatable {
        case idle
        case listening
        /// Seconds left before sending.
        case countdown(Int)
    }

    static let countdownSeconds = 3
    /// How long a pause in speech ends listening.
    static let silence: Duration = .milliseconds(1800)

    private(set) var isOn = false
    private(set) var phase: Phase = .idle
    private(set) var transcript = ""
    private(set) var hint = "Tap to talk"
    /// When the countdown started, for the draining ring; nil while it's frozen for a screenshot.
    private(set) var countdownStarted: Date?

    @ObservationIgnored var onSend: ((String) -> Void)?
    @ObservationIgnored var onToggle: ((Bool) -> Void)?

    @ObservationIgnored private let listener: any SpeechListening
    @ObservationIgnored private let speaker: Speaker
    @ObservationIgnored private var silenceTimer: Task<Void, Never>?
    @ObservationIgnored private var countdownTask: Task<Void, Never>?

    init(listener: any SpeechListening, speaker: Speaker) {
        self.listener = listener
        self.speaker = speaker
    }

    func setOn(_ on: Bool, quiet: Bool = false) {
        guard on != isOn else { return }
        isOn = on
        onToggle?(on)
        UIApplication.shared.isIdleTimerDisabled = on
        reset(hint: "Tap to talk")
        if on {
            if !quiet { speaker.say("Hands-free on. Tap the mic to talk.") }
        } else {
            speaker.stop()
        }
    }

    func micTapped() {
        if phase == .listening {
            listener.stop()
        } else {
            startListening()
        }
    }

    /// Tapping the countdown cancels the send.
    func cancelCountdown() {
        guard case .countdown = phase else { return }
        reset(hint: "Canceled. Tap to talk")
    }

    /// A frozen countdown for App Store screenshots.
    func showPreview(transcript: String) {
        isOn = true
        self.transcript = transcript
        phase = .countdown(Self.countdownSeconds)
        countdownStarted = nil
    }

    private func startListening() {
        speaker.stop()
        reset(hint: "Listening… pause when you're done")
        phase = .listening
        listener.start(
            onText: { [weak self] text in self?.heard(text) },
            onEnd: { [weak self] end in self?.ended(end) }
        )
    }

    private func heard(_ text: String) {
        guard phase == .listening else { return }
        transcript = text.trimmingCharacters(in: .whitespacesAndNewlines)
        silenceTimer?.cancel()
        silenceTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.silence)
            guard !Task.isCancelled else { return }
            self?.listener.stop()
        }
    }

    private func ended(_ end: ListenEnd) {
        silenceTimer?.cancel()
        guard phase == .listening else { return }
        switch end {
        case .finished where !transcript.isEmpty:
            startCountdown()
        case .finished:
            reset(hint: "Didn't catch that. Tap to try again")
        case .denied:
            reset(hint: "Allow the microphone and speech recognition for Yo in Settings, then tap again")
        case .failed:
            reset(hint: "Couldn't listen. Tap to try again")
        }
    }

    private func startCountdown() {
        let text = transcript
        phase = .countdown(Self.countdownSeconds)
        countdownStarted = Date()
        Haptics.tap()
        countdownTask = Task { [weak self] in
            for left in stride(from: Self.countdownSeconds - 1, through: 0, by: -1) {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                if left > 0 {
                    phase = .countdown(left)
                } else {
                    reset(hint: "Sent. Tap to talk again")
                    onSend?(text)
                }
            }
        }
    }

    private func reset(hint: String) {
        silenceTimer?.cancel()
        countdownTask?.cancel()
        countdownTask = nil
        if phase == .listening { listener.cancel() }
        phase = .idle
        transcript = ""
        countdownStarted = nil
        self.hint = hint
    }
}
