import Foundation
import Testing
@testable import Yo
import YoPhoneKit

@MainActor
@Suite struct AppModelTests {
    let vault = MemoryVault()
    let store = MemorySessionStore()
    let relay = StubRelay()
    let defaults: UserDefaults = {
        let name = "yo-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        d.set(true, forKey: "aiNoticeSeen")
        d.set(true, forKey: "installed")
        return d
    }()

    private func makeModel(started: Bool = true) -> AppModel {
        let relay = relay
        let model = AppModel(vault: vault, store: store, defaults: defaults, listener: FakeListener(),
                             makeTransport: { _, _ in relay })
        model.setActive(true)
        if started { model.start(LaunchOptions(arguments: [])) }
        return model
    }

    private func link(_ byte: UInt8) -> PhoneLink {
        PhoneLink(secret: Base64URL.encode(Data(repeating: byte, count: 32)), admit: Links.admit, signPub: Links.signPub)
    }

    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(150))
    }

    @Test func rejectsBadAndOldLinks() {
        let model = makeModel()
        #expect(!model.pair(text: "hello"))
        #expect(model.pairingError == PhoneLink.badLinkMessage)
        #expect(!model.pair(text: "https://yo-phone.vercel.app/#k=\(Base64URL.encode(Data(count: 32)))"))
        #expect(model.pairingError == PhoneLink.oldLinkMessage)
        #expect(model.session == nil)
    }

    @Test func pairingSavesTheLinkAndSaysHello() async throws {
        let model = makeModel()
        #expect(model.pair(text: Links.make(secretByte: 1)))
        let session = try #require(model.session)
        #expect(vault.load() == session.link)
        #expect(session.pairedAt != nil)
        try await settle()
        #expect(await relay.posted.count == 1)
        #expect(model.pairingError == nil)
    }

    @Test func theFirstPairingWaitsForTheAINotice() async throws {
        defaults.removeObject(forKey: "aiNoticeSeen")
        let model = makeModel()
        #expect(model.pair(text: Links.make(secretByte: 1)))
        #expect(model.session == nil)
        #expect(model.linkAwaitingNotice != nil)
        model.acknowledgeNotice()
        #expect(model.linkAwaitingNotice == nil)
        #expect(model.session != nil)
        #expect(defaults.bool(forKey: "aiNoticeSeen"))
    }

    @Test func debugBuildsAcceptALocalRelay() {
        let model = makeModel()
        #expect(model.pair(text: Links.make(secretByte: 2, host: "http://localhost:5199")))
        #expect(model.session?.link.relayHost == "localhost:5199")
    }

    @Test func aDifferentLinkAsksBeforeReplacing() async throws {
        let model = makeModel()
        model.pair(text: Links.make(secretByte: 1))
        let first = try #require(model.session)
        await first.send("keep me?")

        model.open(URL(string: Links.make(secretByte: 1))!)
        #expect(model.linkToConfirm == nil)

        model.open(URL(string: Links.make(secretByte: 3))!)
        #expect(model.linkToConfirm != nil)
        #expect(model.session === first)

        model.confirmReplacement()
        #expect(model.session !== first)
        #expect(model.session?.items.isEmpty == true)
        #expect(vault.load()?.secret == Base64URL.encode(Data(repeating: 3, count: 32)))
    }

    @Test func resumesAStoredLinkOnLaunch() throws {
        try vault.save(link(4))
        let model = makeModel()
        #expect(model.session?.link == link(4))
    }

    @Test func aReinstallForgetsTheKeychainLink() throws {
        try vault.save(link(4))
        store.save(SessionSnapshot(items: [.mine(id: "m", text: "old", at: Date())]))
        defaults.removeObject(forKey: "installed")
        let model = makeModel()
        #expect(model.session == nil)
        #expect(vault.load() == nil && store.snapshot == nil)
        #expect(defaults.bool(forKey: "installed"))
    }

    @Test func aLinkThatOpenedTheAppWaitsForStartAndAsksBeforeReplacing() throws {
        try vault.save(link(4))
        let model = makeModel(started: false)
        model.open(URL(string: Links.make(secretByte: 9))!)
        #expect(model.linkToConfirm == nil)
        model.start(LaunchOptions(arguments: []))
        #expect(model.session?.link == link(4))
        #expect(model.linkToConfirm?.secret == link(9).secret)
    }

    @Test func theDemoStillAsksBeforeReplacingTheSavedLink() throws {
        try vault.save(link(4))
        let model = makeModel(started: false)
        model.start(LaunchOptions(arguments: ["Yo", "-YoDemo"]))
        #expect(model.isDemo)
        model.open(URL(string: Links.make(secretByte: 9))!)
        #expect(model.linkToConfirm?.secret == link(9).secret)
        #expect(model.isDemo)
        model.confirmReplacement()
        #expect(!model.isDemo)
        #expect(vault.load()?.secret == link(9).secret)
    }

    @Test func aRevokedLinkGoesBackToPairing() async throws {
        let model = makeModel()
        model.pair(text: Links.make(secretByte: 5))
        await relay.fail(with: .revoked)
        for _ in 0..<40 where model.session != nil {
            await model.session?.pollOnce()
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(model.session == nil)
        #expect(model.linkWasRevoked)
        #expect(vault.load() == nil)
        #expect(store.snapshot == nil)
        #expect(defaults.bool(forKey: "linkRevoked"))

        await relay.fail(with: nil)
        model.pair(text: Links.make(secretByte: 6))
        #expect(!model.linkWasRevoked)
    }

    @Test func forgetClearsEverything() async {
        let model = makeModel()
        model.pair(text: Links.make(secretByte: 7))
        await model.session?.send("hi")
        model.forget()
        #expect(model.session == nil)
        #expect(vault.load() == nil)
        #expect(store.snapshot == nil)
        #expect(!model.linkWasRevoked)
    }

    @Test func theDemoIsLocalAndLeavesTheLinkAlone() async throws {
        let link = PhoneLink(secret: Base64URL.encode(Data(repeating: 8, count: 32)), admit: Links.admit,
                             signPub: Links.signPub)
        try vault.save(link)
        let model = makeModel(started: false)
        model.startDemo()
        #expect(model.isDemo)
        #expect(model.session?.link.relayHost == "demo.yo.invalid")
        try await settle()
        #expect(await relay.posted.isEmpty)

        model.leaveDemo()
        #expect(!model.isDemo)
        #expect(model.session?.link == link)
    }

    @Test func screenshotScenesSetTheStage() {
        let model = makeModel()
        model.start(LaunchOptions(arguments: ["Yo", "-YoScreenshotScene", "settings"]))
        #expect(model.showSettings)
        #expect(!model.isDemo)
        #expect(model.session?.link.relayHost == "yo-phone.vercel.app")

        model.start(LaunchOptions(arguments: ["Yo", "-YoScreenshotScene", "drive"]))
        #expect(model.drive.isOn)
        #expect(model.drive.transcript == DemoScene.driveTranscript)

        model.start(LaunchOptions(arguments: ["Yo", "-YoScreenshotScene", "welcome"]))
        #expect(model.session == nil)
    }

    @Test func launchOptions() {
        let options = LaunchOptions(arguments: ["Yo", "-YoDemo", "-YoScreenshotScene", "approval", "-YoPairLink", "x",
                                                "-YoResetState"])
        #expect(options.demo && options.scene == .approval && options.pairLink == "x" && options.resetState)
        #expect(LaunchOptions(arguments: ["Yo", "-YoScreenshotScene", "nope"]).scene == nil)
    }
}
