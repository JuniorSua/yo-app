import SwiftUI
import YoPhoneKit

/// Connection status, voice, help and privacy, and forgetting the link.
struct SettingsView: View {
    let session: PhoneSession
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    row("Talking to", session.agentName)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        row("Yo's computer", session.lastSeenText(at: context.date))
                    }
                    row("Relay", model.isDemo ? "None, it's the demo" : session.link.relayHost)
                    if let pairedAt = session.pairedAt {
                        row("Linked", pairedAt.formatted(date: .abbreviated, time: .omitted))
                    }
                } header: {
                    Text("Connection")
                } footer: {
                    if !model.isDemo {
                        Text("Messages are end-to-end encrypted. The relay only holds scrambled text for a short time and can't read it.")
                    }
                }

                Section {
                    Toggle("Read replies aloud", isOn: Binding(get: { model.readAloud }, set: model.setReadAloud))
                        .tint(Palette.green)
                } footer: {
                    Text("Always read Yo's replies out loud. Drive mode reads them anyway.")
                }

                Section {
                    Link(destination: AppModel.helpURL) { linkRow("Help", "questionmark.circle") }
                    Link(destination: AppModel.privacyURL) { linkRow("Privacy Policy", "hand.raised") }
                }

                Section {
                    if model.isDemo {
                        Button("Leave the demo") {
                            dismiss()
                            model.leaveDemo()
                        }
                        .frame(maxWidth: .infinity)
                        .fontWeight(.semibold)
                    } else {
                        Button("Forget this link", role: .destructive) { confirmForget = true }
                            .frame(maxWidth: .infinity)
                            .fontWeight(.semibold)
                            .accessibilityIdentifier("forget")
                    }
                } footer: {
                    VStack(spacing: 16) {
                        if !model.isDemo {
                            Text("Forgetting removes the link and your messages from this iPhone. You'll need a new link to text Yo again.")
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Text("Yo \(Self.version)")
                            .font(.geistMono(12, relativeTo: .caption))
                            .foregroundStyle(Palette.faint)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
            .font(.geist(17))
            .listRowBackground(Palette.card)
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("settings-done")
                }
            }
            .confirmationDialog("Forget this link?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget", role: .destructive) {
                    dismiss()
                    model.forget()
                }
            } message: {
                Text("This removes the link and your messages from this iPhone.")
            }
        }
        .presentationDetents([.large])
    }

    private func row(_ title: String, _ value: String) -> some View {
        LabeledContent(title) {
            Text(value).foregroundStyle(Palette.muted)
        }
    }

    private func linkRow(_ title: String, _ icon: String) -> some View {
        HStack {
            Label(title, systemImage: icon)
            Spacer()
            Image(systemName: "arrow.up.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.faint)
        }
        .foregroundStyle(Palette.ink)
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }
}
