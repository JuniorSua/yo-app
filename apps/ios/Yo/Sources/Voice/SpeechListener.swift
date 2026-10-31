import AVFoundation
import Speech

enum ListenEnd: Equatable {
    /// Listening stopped normally; the transcript so far is final.
    case finished
    /// The owner hasn't allowed the microphone or speech recognition.
    case denied
    case failed
}

/// Turns speech into text. `SpeechListener` is the real one; tests use a fake.
@MainActor
protocol SpeechListening: AnyObject {
    func start(onText: @escaping (String) -> Void, onEnd: @escaping (ListenEnd) -> Void)
    /// Stop listening and finish with what was heard.
    func stop()
    /// Stop without finishing.
    func cancel()
}

/// SFSpeechRecognizer fed by AVAudioEngine. Recognition stays on the iPhone whenever the device supports it.
@MainActor
final class SpeechListener: SpeechListening {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var onText: ((String) -> Void)?
    private var onEnd: ((ListenEnd) -> Void)?
    /// Bumped by every start and cancel, so a start still waiting for permission can tell it was called off.
    private var generation = 0

    func start(onText: @escaping (String) -> Void, onEnd: @escaping (ListenEnd) -> Void) {
        cancel()
        generation += 1
        let current = generation
        self.onText = onText
        self.onEnd = onEnd
        Task {
            let allowed = await Self.authorize()
            guard current == generation else { return }
            guard allowed else { return finish(.denied) }
            guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return finish(.failed) }
            do {
                try begin(with: recognizer)
            } catch {
                finish(.failed)
            }
        }
    }

    func stop() {
        guard request != nil else { return }
        stopAudio()
        request?.endAudio()
    }

    func cancel() {
        generation += 1
        onText = nil
        onEnd = nil
        task?.cancel()
        teardown()
    }

    private func begin(with recognizer: SFSpeechRecognizer) throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try audio.setActive(true, options: .notifyOthersOnDeactivation)

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        // No microphone (e.g. the Simulator without one): there's nothing to listen to.
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CocoaError(.featureUnsupported) }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request

        Self.installTap(on: input, format: format, feeding: request)
        engine.prepare()
        try engine.start()
        task = Self.recognize(request, with: recognizer) { [weak self] text, isFinal, failed in
            self?.update(text: text, isFinal: isFinal, failed: failed)
        }
    }

    private func update(text: String?, isFinal: Bool, failed: Bool) {
        if let text, !text.isEmpty { onText?(text) }
        if isFinal || failed { finish(.finished) }
    }

    private func finish(_ end: ListenEnd) {
        let onEnd = onEnd
        self.onEnd = nil
        onText = nil
        teardown()
        onEnd?(end)
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }

    private func teardown() {
        stopAudio()
        request = nil
        task = nil
        let audio = AVAudioSession.sharedInstance()
        try? audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
    }

    // These run off the main actor: the audio tap and the recognizer call back on their own threads.

    private nonisolated static func installTap(on input: AVAudioInputNode, format: AVAudioFormat,
                                               feeding request: SFSpeechAudioBufferRecognitionRequest) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    }

    private nonisolated static func recognize(
        _ request: SFSpeechAudioBufferRecognitionRequest, with recognizer: SFSpeechRecognizer,
        update: @escaping @MainActor (String?, Bool, Bool) -> Void
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in update(text, isFinal, failed) }
        }
    }

    private nonisolated static func authorize() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }
}
