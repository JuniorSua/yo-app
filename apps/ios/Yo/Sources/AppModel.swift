import Foundation
import Observation
import YoPhoneKit

/// The app's state: which link is paired (or the demo), and what happens when a link arrives, is revoked or
/// is forgotten. The conversation itself is a `PhoneSession`.
@MainActor
@Observable
final class AppModel {
    enum Mode: Equatable {
        case live
        case demo
        case screenshot(DemoScene)
    }

    private(set) var session: PhoneSession?
    private(set) var mode: Mode = .live
    /// Shown on the welcome screen under the paste box.
    var pairingError: String?
    /// The last link was turned off from Yo.
    private(set) var linkWasRevoked: Bool
    /// A different link arrived while one is paired: ask before replacing it.
    var linkToConfirm: PhoneLink?
    /// The first link waits here while the owner reads where messages go (shown once, before the first pairing).
    var linkAwaitingNotice: PhoneLink?
    var showSettings = false
    private(set) var toast: String?
    var readAloud: Bool {
        didSet { defaults.set(readAloud, forKey: Keys.readAloud) }
    }

    let drive: DriveController
    private let speaker: Speaker
    private let vault: any LinkVault
    private let store: any SessionStore
    private let defaults: UserDefaults
    private let makeTransport: (PhoneLink, PhoneKeys) -> any RelayTransport
    private var isActive = false
    private var didStart = false
    /// Links opened before `start` ran, handled right after it.
    private var openedBeforeStart: [URL] = []
    private var toastTask: Task<Void, Never>?

    private enum Keys {
        static let readAloud = "readAloud"
        static let drive = "drive"
        static let revoked = "linkRevoked"
        static let aiNoticeSeen = "aiNoticeSeen"
        static let installed = "installed"
    }

    static let privacyURL = URL(string: "https://yo-app-five.vercel.app/privacy")!
    static let helpURL = URL(string: "https://yo-app-five.vercel.app/support")!

    init(vault: any LinkVault = KeychainLinkVault(),
         store: any SessionStore = FileSessionStore.standard(),
         defaults: UserDefaults = .standard,
         speaker: Speaker = Speaker(),
         listener: any SpeechListening = SpeechListener(),
         makeTransport: @escaping (PhoneLink, PhoneKeys) -> any RelayTransport = { HTTPRelayClient(link: $0, keys: $1) }) {
        self.vault = vault
        self.store = store
        self.defaults = defaults
        self.speaker = speaker
        self.makeTransport = makeTransport
        drive = DriveController(listener: listener, speaker: speaker)
        readAloud = defaults.bool(forKey: Keys.readAloud)
        linkWasRevoked = defaults.bool(forKey: Keys.revoked)
        drive.onSend = { [weak self] text in
            guard let session = self?.session else { return }
            Task { await session.send(text) }
        }
        drive.onToggle = { [weak self] on in
            guard let self, mode == .live else { return }
            defaults.set(on, forKey: Keys.drive)
        }
    }

    /// The demo is labeled as one; screenshot scenes look like a paired Yo.
    var isDemo: Bool { mode == .demo }

    // MARK: - Launch

    func start(_ options: LaunchOptions) {
        // UserDefaults go away with the app but the Keychain doesn't: a reinstall starts from nothing.
        if !defaults.bool(forKey: Keys.installed) {
            vault.clear()
            store.clear()
            defaults.set(true, forKey: Keys.installed)
        }
        if options.resetState {
            vault.clear()
            store.clear()
            for key in [Keys.readAloud, Keys.drive, Keys.revoked, Keys.aiNoticeSeen] { defaults.removeObject(forKey: key) }
            linkWasRevoked = false
            readAloud = false
        }
        if let scene = options.scene {
            showScene(scene)
        } else if options.demo {
            startDemo()
        } else if let text = options.pairLink {
            pair(text: text)
        } else if let link = vault.load() {
            connect(link, isNew: false)
        }
        didStart = true
        let opened = openedBeforeStart
        openedBeforeStart = []
        opened.forEach(open)
    }

    func setActive(_ active: Bool) {
        isActive = active
        guard let session else { return }
        if active {
            session.activate()
            Task { await session.sayHello() }
        } else {
            session.deactivate()
        }
    }

    // MARK: - Pairing

    /// Pairs from pasted or scanned text. Returns false and sets `pairingError` when it isn't a usable link.
    @discardableResult
    func pair(text: String) -> Bool {
        let parsed = PhoneLink.parse(text, allowInsecureLocalhost: LaunchOptions.allowsLocalRelay)
        guard case let .link(link) = parsed else {
            pairingError = parsed.errorMessage
            Haptics.failure()
            return false
        }
        pair(link)
        return true
    }

    /// A link opened from outside the app: a universal link or the iPhone Camera.
    func open(_ url: URL) {
        guard didStart else {
            openedBeforeStart.append(url)
            return
        }
        let parsed = PhoneLink.parse(url.absoluteString, allowInsecureLocalhost: LaunchOptions.allowsLocalRelay)
        guard case let .link(link) = parsed else {
            if session == nil { pairingError = parsed.errorMessage } else { show(parsed.errorMessage ?? "") }
            return
        }
        pair(link)
    }

    private func pair(_ link: PhoneLink) {
        pairingError = nil
        // The saved link is the one that counts, whether or not its session is running (cold launch, demo).
        if let saved = vault.load(), saved.secret != link.secret {
            if linkToConfirm != link { linkToConfirm = link }
            return
        }
        if mode == .live, session?.link.secret == link.secret { return }
        proceed(with: link)
    }

    /// Pairs, after the one-time notice if it hasn't been shown yet.
    private func proceed(with link: PhoneLink) {
        guard defaults.bool(forKey: Keys.aiNoticeSeen) else {
            linkAwaitingNotice = link
            return
        }
        connect(link, isNew: vault.load()?.secret != link.secret)
    }

    /// The owner read the one-time notice and continues pairing.
    func acknowledgeNotice() {
        defaults.set(true, forKey: Keys.aiNoticeSeen)
        guard let link = linkAwaitingNotice else { return }
        linkAwaitingNotice = nil
        proceed(with: link)
    }

    func confirmReplacement() {
        guard let link = linkToConfirm else { return }
        linkToConfirm = nil
        proceed(with: link)
    }

    private func connect(_ link: PhoneLink, isNew: Bool) {
        // A link saved by a debug build may name a plain-http local relay that this build doesn't allow.
        guard link.usesAllowedRelay(allowInsecureLocalhost: LaunchOptions.allowsLocalRelay) else {
            vault.clear()
            store.clear()
            pairingError = PhoneLink.badLinkMessage
            return
        }
        tearDown()
        if isNew {
            // A new link is a new mailbox: start clean.
            store.clear()
            store.save(SessionSnapshot(pairedAt: Date()))
        }
        do {
            let keys = try PhoneKeys(secret: link.secret)
            // Only an unsigned build can fail to save; pairing still works, the link just isn't remembered.
            try? vault.save(link)
            let session = try PhoneSession(link: link, transport: makeTransport(link, keys), store: store)
            mode = .live
            linkWasRevoked = false
            defaults.set(false, forKey: Keys.revoked)
            install(session)
            drive.setOn(defaults.bool(forKey: Keys.drive), quiet: true)
            Task { await session.sayHello(force: isNew) }
        } catch {
            pairingError = PhoneLink.badLinkMessage
        }
    }

    // MARK: - Demo

    func startDemo() {
        tearDown()
        let core = DemoCore()
        let session = try! PhoneSession(link: core.link, transport: core,
                                        store: MemorySessionStore(SessionSnapshot(pairedAt: Date())),
                                        config: .init(pollInterval: .milliseconds(400)))
        mode = .demo
        install(session)
        Task { await session.sayHello(force: true) }
    }

    func leaveDemo() {
        tearDown()
        mode = .live
        if let link = vault.load() { connect(link, isNew: false) }
    }

    private func showScene(_ scene: DemoScene) {
        tearDown()
        mode = .screenshot(scene)
        linkWasRevoked = false
        pairingError = nil
        guard let snapshot = scene.snapshot(on: Date()) else { return }
        let core = DemoCore(opening: scene.opening, openCards: scene.openCards, relay: PhoneLink.defaultRelay)
        let session = try! PhoneSession(link: core.link, transport: core, store: MemorySessionStore(snapshot),
                                        config: .init(pollInterval: .milliseconds(400)))
        install(session)
        switch scene {
        case .drive: drive.showPreview(transcript: DemoScene.driveTranscript)
        case .settings: showSettings = true
        default: break
        }
    }

    // MARK: - Leaving

    /// Forgets the link and the conversation on this iPhone.
    func forget() {
        let wasLive = mode == .live
        tearDown()
        mode = .live
        guard wasLive else { return }
        vault.clear()
        store.clear()
        defaults.set(false, forKey: Keys.drive)
    }

    private func revoked() {
        forget()
        linkWasRevoked = true
        defaults.set(true, forKey: Keys.revoked)
        pairingError = nil
    }

    private func tearDown() {
        showSettings = false
        drive.setOn(false, quiet: true)
        session?.onEvent = nil
        session?.close()
        session = nil
    }

    // MARK: - Session events

    private func install(_ session: PhoneSession) {
        session.onEvent = { [weak self] event in self?.handle(event) }
        self.session = session
        if isActive { session.activate() }
    }

    private func handle(_ event: SessionEvent) {
        switch event {
        case .sent:
            Haptics.tap()
        case let .reply(text):
            Haptics.tap()
            speak(text)
        case let .card(card):
            Haptics.attention()
            speak(card.kind == .openYo ? "\(card.title). Open Yo on your computer." : "Yo needs you: \(card.title)")
        case let .failure(text):
            Haptics.failure()
            speak("Something went wrong. \(text)")
        case let .notice(text):
            Haptics.failure()
            show(text)
        case .revoked:
            Haptics.failure()
            revoked()
        }
    }

    private func speak(_ text: String) {
        guard drive.isOn || readAloud else { return }
        speaker.say(text)
    }

    func setReadAloud(_ on: Bool) {
        readAloud = on
        if on { speaker.say("Replies will be read aloud.") }
    }

    func show(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(for: .seconds(3.2))
            guard !Task.isCancelled else { return }
            toast = nil
        }
    }
}
