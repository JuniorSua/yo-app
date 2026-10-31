import AVFoundation
import YoPhoneKit

/// Reads Yo's replies aloud, without the Markdown. Other audio ducks while Yo speaks and comes back after.
@MainActor
final class Speaker: NSObject {
    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func say(_ text: String) {
        let said = Markdown.speech(text)
        guard !said.isEmpty else { return }
        let audio = AVAudioSession.sharedInstance()
        if !Self.isListening {
            try? audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        }
        let utterance = AVSpeechUtterance(string: String(said.prefix(1200)))
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.02
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    /// Drive mode's microphone owns the session while it records (SpeechListener sets `.playAndRecord`).
    private static var isListening: Bool {
        AVAudioSession.sharedInstance().category == .playAndRecord
    }

    /// Lets ducked music come back once nothing is left to say.
    private func releaseAudio() {
        guard !synthesizer.isSpeaking, !Self.isListening else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

extension Speaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.releaseAudio() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.releaseAudio() }
    }
}
