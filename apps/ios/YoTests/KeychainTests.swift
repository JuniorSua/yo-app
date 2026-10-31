import Foundation
import Testing
import YoPhoneKit

@Suite struct KeychainTests {
    @Test func savesLoadsAndClearsTheLink() throws {
        let vault = KeychainLinkVault(service: "dev.yo.phone.tests", account: UUID().uuidString)
        let link = PhoneLink(secret: Base64URL.encode(Data(repeating: 9, count: 32)), admit: Links.admit,
                             signPub: Links.signPub, relay: URL(string: "https://relay.example.com")!)
        #expect(vault.load() == nil)
        try vault.save(link)
        #expect(vault.load() == link)
        try vault.save(link)
        #expect(vault.load() == link)
        vault.clear()
        #expect(vault.load() == nil)
    }
}
