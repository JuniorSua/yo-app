import Contacts
import Foundation

/// Read-only Contacts access. Fetches only the keys in `keysToFetch`; never notes or images.
public final class ContactsStoreBackend: ContactsBackend {
    static let keysToFetch: [String] = [
        CNContactIdentifierKey, CNContactGivenNameKey, CNContactMiddleNameKey, CNContactFamilyNameKey,
        CNContactNicknameKey, CNContactOrganizationNameKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
    ]

    /// Created on first use; constructing a store never prompts.
    private lazy var store = CNContactStore()

    public init() {}

    public func status() -> AccessStatus { Permissions.contacts() }

    public func requestAccess(timeout: TimeInterval) -> AccessStatus {
        let waiter = Waiter<Bool>()
        let box = UncheckedBox(value: store)
        // The prompt's callback arrives on a framework queue; the session thread just waits.
        DispatchQueue.global(qos: .userInitiated).async {
            box.value.requestAccess(for: .contacts) { granted, _ in waiter.fulfill(granted) }
        }
        _ = waiter.wait(timeout: timeout)
        return status()
    }

    public func search(name: String) throws(BridgeError) -> [ContactRecord] {
        try fetch(CNContact.predicateForContacts(matchingName: name))
    }

    public func search(phone: String) throws(BridgeError) -> [ContactRecord] {
        try fetch(CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: phone)))
    }

    public func search(email: String) throws(BridgeError) -> [ContactRecord] {
        try fetch(CNContact.predicateForContacts(matchingEmailAddress: email))
    }

    private func fetch(_ predicate: NSPredicate) throws(BridgeError) -> [ContactRecord] {
        let contacts: [CNContact]
        do {
            contacts = try store.unifiedContacts(matching: predicate, keysToFetch: Self.keysToFetch as [CNKeyDescriptor])
        } catch let error as CNError where error.code == .authorizationDenied {
            throw PIMService.permission("contacts", status())
        } catch {
            throw BridgeError(.io, "contacts search failed")
        }
        return contacts.map { contact in
            ContactRecord(
                id: contact.identifier, givenName: contact.givenName, middleName: contact.middleName,
                familyName: contact.familyName, nickname: contact.nickname, organization: contact.organizationName,
                phones: contact.phoneNumbers.map {
                    LabeledValue(label: Self.label($0.label), value: $0.value.stringValue)
                },
                emails: contact.emailAddresses.map { LabeledValue(label: Self.label($0.label), value: $0.value as String) })
        }
    }

    private static func label(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let localized = CNLabeledValue<NSString>.localizedString(forLabel: raw)
        return localized.isEmpty ? nil : localized
    }
}
