import CryptoKit
import Foundation
import Testing
@testable import YoPhoneKit

/// Protocol v2.1 (docs/phone/PROTOCOL.md): `images` items, and `caps`, `pics` and `helpers` fields. This app doesn't
/// show pictures yet, so it must step past them and read everything else exactly as before.
@Suite struct ProtocolV21Tests {
    let keys = try! PhoneKeys(secret: Base64URL.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }))
    let signer = Curve25519.Signing.PrivateKey()
    var verifier: ReplyVerifier { ReplyVerifier(signPub: Base64URL.encode(signer.publicKey.rawRepresentation))! }

    private func item(_ seq: Int, _ json: String) -> OutItem {
        let box = try! keys.seal(Data(json.utf8), .out)
        let sig = try! signer.signature(for: ReplyVerifier.message(for: box))
        return OutItem(seq: seq, box: box, sig: Base64URL.encode(sig))
    }

    private static let images = #"{"v":1,"n":11,"t":"images","replyId":"r1","items":[{"id":"p1","alt":"chart","mime":"image/png","w":640,"h":480,"size":12345,"hash":"abc"}],"more":0}"#

    private func out(_ json: String) -> OutMessage? {
        OutMessage(json: Data(json.utf8))
    }

    @Test func imagesItemIsNotAMessageThisAppKnows() {
        #expect(out(Self.images) == nil)
    }

    @Test func imagesBetweenTwoRepliesAreSkippedButTheCursorAndCounterMove() {
        let items = [
            item(1, #"{"v":1,"n":10,"t":"reply","id":"r1","text":"Here's the chart","pics":1}"#),
            item(2, Self.images),
            item(3, #"{"v":1,"n":12,"t":"reply","id":"r2","text":"Anything else?"}"#),
        ]
        let res = Inbox.accept(items, cursor: 0, lastN: nil, verifier: verifier, keys: keys)
        #expect(res.messages == [
            .reply(id: "r1", text: "Here's the chart", at: nil, agent: nil),
            .reply(id: "r2", text: "Anything else?", at: nil, agent: nil),
        ])
        #expect(res.cursor == 3 && res.lastN == 12 && res.dropped.isEmpty && res.maxSeq == 3)

        // An `images` item as the last thing on the page still moves the cursor, so it isn't fetched again.
        let tail = Inbox.accept([item(4, #"{"v":1,"n":13,"t":"images","replyId":"r2","items":[],"more":0}"#)],
                                cursor: res.cursor, lastN: res.lastN, verifier: verifier, keys: keys)
        #expect(tail.messages.isEmpty && tail.cursor == 4 && tail.lastN == 13 && tail.dropped.isEmpty)
    }

    @Test func extraFieldsParseAsBefore() {
        #expect(out(#"{"v":1,"n":1,"t":"hello","agent":{"name":"Yo"},"caps":["images","photos","helpers"],"at":1}"#)
            == .hello(agentName: "Yo"))
        #expect(out(#"{"v":1,"n":2,"t":"reply","id":"r1","agent":"Yo","text":"Look","at":1767225600000,"pics":2}"#)
            == .reply(id: "r1", text: "Look", at: Date(millis: 1_767_225_600_000), agent: "Yo"))
        #expect(out(#"{"v":1,"n":3,"t":"status","agent":"Yo","state":"working","detail":"Checking","helpers":2}"#)
            == .status(state: .working, detail: "Checking", agent: "Yo"))
    }
}

@MainActor
@Suite struct ProtocolV21SessionTests {
    let core = FakeCore()
    let store = MemorySessionStore()

    @Test func sessionShowsBothRepliesAroundAnImagesItemAndSavesTheCursor() async throws {
        let session = try PhoneSession(link: core.link, transport: core, store: store)
        await core.emit(fields: ["t": "hello", "agent": ["name": "Yo"], "caps": ["images", "photos", "helpers"]])
        await core.emit(fields: ["t": "status", "agent": "Yo", "state": "working", "detail": "Drawing", "helpers": 1])
        await core.emit(fields: ["t": "reply", "id": "r1", "agent": "Yo", "text": "Here you go", "pics": 1])
        await core.emit(fields: ["t": "images", "replyId": "r1", "more": 0, "items": [
            ["id": "p1", "alt": "chart", "mime": "image/png", "w": 640, "h": 480, "size": 1234, "hash": "abc"],
        ]])
        await core.emit(fields: ["t": "reply", "id": "r2", "agent": "Yo", "text": "Done"])
        await session.pollOnce()
        #expect(session.items.map(\.text) == ["Here you go", "Done"])
        #expect(session.cursor == 5 && session.lastN == 1_005)
        #expect(store.snapshot?.cursor == 5 && store.snapshot?.lastN == 1_005)

        // Polling again asks only for what's after the images item, and the next reply still shows.
        await core.emit(fields: ["t": "reply", "id": "r3", "agent": "Yo", "text": "Later"])
        await session.pollOnce()
        #expect(await core.getOutCalls.last == 5)
        #expect(session.items.map(\.text) == ["Here you go", "Done", "Later"])
        #expect(session.cursor == 6)
    }
}

@Suite struct PictureMarkdownTests {
    private func paragraph(_ text: String) -> AttributedString? {
        if case let .paragraph(s) = Markdown.parse(text).first { s } else { nil }
    }

    @Test func picturesBecomeANoteInsteadOfRawMarkup() throws {
        let s = try #require(paragraph("Here it is: ![Sales chart](/Users/me/Yo/out/chart.png) done"))
        #expect(String(s.characters) == "Here it is: Picture: Sales chart done")
        let note = try #require(s.runs.first { String(s[$0.range].characters) == "Picture: Sales chart" })
        #expect(note.inlinePresentationIntent == .emphasized)
        #expect(note.link == nil)

        #expect(String(try #require(paragraph("![](/tmp/a.png)")).characters) == "Picture in Yo")
        // A web picture isn't turned into a "!" plus a link either.
        let web = try #require(paragraph("![logo](https://example.com/logo.png)"))
        #expect(String(web.characters) == "Picture: logo")
        #expect(web.runs.allSatisfy { $0.link == nil })
        // Ordinary links are unchanged.
        let link = try #require(paragraph("[docs](https://example.com)"))
        #expect(link.runs.first?.link == URL(string: "https://example.com"))
    }

    @Test func speechSaysPicture() {
        #expect(Markdown.speech("Look ![chart](/tmp/c.png) here") == "Look (picture) chart here")
    }
}
