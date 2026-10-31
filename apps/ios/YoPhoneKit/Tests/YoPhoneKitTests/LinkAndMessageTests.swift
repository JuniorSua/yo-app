import Foundation
import Testing
@testable import YoPhoneKit

private let v = Vector.shared
private let params = "k=\(v.secret)&a=\(v.admit)&p=\(v.signPub)"

@Suite struct PhoneLinkTests {
    @Test func acceptsTheFullLinkTheFragmentOrTheLinkInsideText() throws {
        let expected = PhoneLink(secret: v.secret, admit: v.admit, signPub: v.signPub)
        #expect(PhoneLink.parse("  \(v.link)\n") == .link(expected))
        #expect(PhoneLink.parse("#\(params)") == .link(expected))
        #expect(PhoneLink.parse("Here's your link: \(v.link) — keep it safe") == .link(expected))
        #expect(PhoneLink.parse("https://yo-phone.vercel.app/?\(params)") == .link(expected))
    }

    @Test func takesTheRelayFromTheLink() throws {
        guard case let .link(link) = PhoneLink.parse("https://relay.example.com:8443/#\(params)") else {
            Issue.record("not parsed")
            return
        }
        #expect(link.relay.absoluteString == "https://relay.example.com:8443")
        #expect(link.relayHost == "relay.example.com:8443")
        #expect(PhoneLink.parse(link.url.absoluteString) == .link(link))
    }

    @Test func plainHTTPOnlyForLocalHostsInDebug() {
        let local = "http://localhost:5199/#\(params)"
        #expect(PhoneLink.parse(local) == .invalid)
        guard case let .link(link) = PhoneLink.parse(local, allowInsecureLocalhost: true) else {
            Issue.record("localhost link not accepted")
            return
        }
        #expect(link.relay.absoluteString == "http://localhost:5199")
        #expect(PhoneLink.parse("http://127.0.0.1:5199/#\(params)", allowInsecureLocalhost: true) != .invalid)
        #expect(PhoneLink.parse("http://evil.example.com/#\(params)", allowInsecureLocalhost: true) == .invalid)
        #expect(PhoneLink.parse("ftp://localhost/#\(params)", allowInsecureLocalhost: true) == .invalid)
    }

    @Test func v1LinksAreOld() {
        #expect(PhoneLink.parse("https://yo-phone.vercel.app/#k=\(v.secret)") == .old)
        #expect(PhoneLink.parse("https://yo-phone.vercel.app/#k=\(v.secret)&a=\(v.admit)") == .old)
        #expect(PhoneLink.parse(v.secret) == .old)
        #expect(PhoneLink.Parsed.old.errorMessage == "This link is from an older version. Ask Yo for a new one.")
    }

    @Test func anythingElseIsInvalid() {
        #expect(PhoneLink.parse("") == .invalid)
        #expect(PhoneLink.parse("hello") == .invalid)
        #expect(PhoneLink.parse("#k=\(v.secret.dropLast())&a=\(v.admit)&p=\(v.signPub)") == .invalid)
        #expect(PhoneLink.parse("#k=\(v.secret)x&a=\(v.admit)&p=\(v.signPub)") == .invalid)
        #expect(PhoneLink.Parsed.invalid.errorMessage
            == "That doesn't look like a Yo phone link. Copy the whole link from Yo and try again.")
    }
}

@Suite struct MessageTests {
    @Test func phoneMessagesSerializeLikeThePWA() {
        let at = Date(millis: 1_767_225_600_000)
        #expect(InMessage.hello(id: "h", device: "iPhone (Yo app)").json.serialized()
            == #"{"v":1,"t":"hello","id":"h","device":"iPhone (Yo app)"}"#)
        #expect(InMessage.msg(id: "m", text: "a \"quote\"\n\\ \u{1}", at: at).json.serialized()
            == #"{"v":1,"t":"msg","id":"m","text":"a \"quote\"\n\\ \u0001","at":1767225600000}"#)
        #expect(InMessage.respond(id: "r", requestId: "q", decision: .approve, answer: nil).json.serialized()
            == #"{"v":1,"t":"respond","id":"r","requestId":"q","decision":"approve"}"#)
        #expect(InMessage.respond(id: "r", requestId: "q", decision: .approve, answer: "Sunline").json.serialized()
            == #"{"v":1,"t":"respond","id":"r","requestId":"q","decision":"approve","answer":"Sunline"}"#)
        #expect(InMessage.stop(id: "s").json.serialized() == #"{"v":1,"t":"stop","id":"s"}"#)
    }

    private func out(_ json: String) -> OutMessage? {
        OutMessage(json: Data(json.utf8))
    }

    @Test func readsEveryCoreMessage() {
        #expect(out(#"{"v":1,"t":"hello","agent":{"name":"Pepe"},"at":1}"#) == .hello(agentName: "Pepe"))
        #expect(out(#"{"v":1,"t":"ack","ids":["a","b",3]}"#) == .ack(ids: ["a", "b"]))
        #expect(out(#"{"v":1,"t":"status","agent":"Yo","state":"working","detail":"Reading"}"#)
            == .status(state: .working, detail: "Reading", agent: "Yo"))
        #expect(out(#"{"v":1,"t":"reply","id":"r1","agent":"Yo","text":"**Hi**","at":1767225600000}"#)
            == .reply(id: "r1", text: "**Hi**", at: Date(millis: 1_767_225_600_000), agent: "Yo"))
        #expect(out(#"{"v":1,"t":"request","requestId":"q","agent":"Yo","kind":"question","title":"Which?","detail":"d","options":["A","B"]}"#)
            == .request(RequestCard(requestId: "q", kind: .question, title: "Which?", detail: "d", options: ["A", "B"],
                                    agent: "Yo")))
        #expect(out(#"{"v":1,"t":"request","requestId":"o","kind":"open_yo","title":"Use your Mac"}"#)
            == .request(RequestCard(requestId: "o", kind: .openYo, title: "Use your Mac")))
        #expect(out(#"{"v":1,"t":"resolved","requestId":"q","outcome":"Approved"}"#)
            == .resolved(requestId: "q", outcome: "Approved"))
        #expect(out(#"{"v":1,"t":"error","agent":"Yo","text":"Yo is busy. Send it again in a minute."}"#)
            == .error(text: "Yo is busy. Send it again in a minute.", agent: "Yo"))
    }

    @Test func readsLenientlyLikeThePWA() {
        #expect(out(#"{"v":1,"t":"request","requestId":"q","kind":"weird","options":[1,2,3,4,5,6,7,8,9,10]}"#)
            == .request(RequestCard(requestId: "q", kind: .approval, title: "Yo needs you",
                                    options: ["1", "2", "3", "4", "5", "6", "7", "8"])))
        #expect(out(#"{"v":1,"t":"resolved","requestId":"q"}"#) == .resolved(requestId: "q", outcome: "Done"))
        #expect(out(#"{"v":1,"t":"error"}"#) == .error(text: "Something went wrong", agent: nil))
        #expect(out(#"{"v":1,"t":"status","state":"working","detail":"\#(String(repeating: "x", count: 200))"}"#)
            == .status(state: .working, detail: String(repeating: "x", count: 120), agent: nil))
        #expect(out(#"{"v":1,"t":"hello","agent":{"name":"\#(String(repeating: "n", count: 80))"}}"#)
            == .hello(agentName: String(repeating: "n", count: 60)))
    }

    @Test func ignoresWhatItDoesNotKnow() {
        #expect(out(#"{"v":2,"t":"reply","text":"x"}"#) == nil)
        #expect(out(#"{"v":1,"t":"teleport"}"#) == nil)
        #expect(out(#"{"v":1,"t":"request"}"#) == nil)
        #expect(out("not json") == nil)
    }

    @Test func coreMessagesRoundTrip() {
        let messages: [OutMessage] = [
            .hello(agentName: "Yo"),
            .ack(ids: ["a"]),
            .status(state: .queued, detail: "", agent: "Yo"),
            .reply(id: "r", text: "hi", at: Date(millis: 5), agent: "Yo"),
            .request(RequestCard(requestId: "q", kind: .question, title: "T", detail: "D", options: ["A"], agent: "Yo")),
            .resolved(requestId: "q", outcome: "Approved"),
            .error(text: "nope", agent: "Yo"),
        ]
        for message in messages {
            #expect(OutMessage(json: message.json().data) == message)
        }
    }
}
