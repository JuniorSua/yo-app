import SwiftUI
import YoPhoneKit

/// First run, or after a link was turned off: explain Yo Phone and take a link.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var linkText = ""
    @State private var showHelp = false
    @State private var showScanner = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                hero
                if model.linkWasRevoked { revokedNotice }
                connectCard
                VStack(spacing: 10) {
                    Button { showHelp = true } label: {
                        Label("How do I get a link?", systemImage: "questionmark.circle")
                    }
                    .buttonStyle(YoButtonStyle(kind: .plain))
                    Button { model.startDemo() } label: {
                        Label("Try the demo", systemImage: "sparkles")
                    }
                    .buttonStyle(YoButtonStyle(kind: .plain))
                    .accessibilityHint("Talk to a pretend Yo on this phone. Nothing is sent anywhere.")
                }
                finePrint
            }
            .padding(.horizontal, 20)
            .padding(.top, 36)
            .padding(.bottom, 28)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(alignment: .top) {
            ZStack(alignment: .top) {
                Palette.bg
                RadialGradient(colors: [Palette.yellow.opacity(0.28), Palette.yellow.opacity(0)],
                               center: .top, startRadius: 0, endRadius: 420)
                    .frame(height: 520)
                    .offset(y: -60)
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showHelp) { LinkHelpView() }
        .sheet(isPresented: $showScanner) {
            QRScannerSheet { text in
                if model.pair(text: text) { showScanner = false }
            }
        }
    }

    private var hero: some View {
        VStack(spacing: 12) {
            Image("Logo")
                .resizable()
                .frame(width: 96, height: 96)
                .shadow(color: Palette.glow.opacity(0.25), radius: 14, y: 12)
                .accessibilityHidden(true)
            Text("Your Yo, in your pocket")
                .font(.geist(32, .semibold, relativeTo: .largeTitle))
                .tracking(-0.6)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Text your Yo from anywhere. It does the work on your computer and texts you back.")
                .font(.geist(17))
                .foregroundStyle(Palette.fg2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 340)
        }
        .padding(.bottom, 8)
    }

    private var revokedNotice: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("This link was turned off. Ask for a new one.")
                .font(.geist(17, .semibold))
                .foregroundStyle(Palette.red)
            Text("In Yo on your computer, open Settings → Phone → Create phone link. Then scan it or paste it below.")
                .font(.geist(15))
                .foregroundStyle(Palette.fg2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Palette.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.red.opacity(0.35)))
        .accessibilityElement(children: .combine)
    }

    private var connectCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Got your link?")
                    .font(.geist(17, .semibold))
                    .accessibilityAddTraits(.isHeader)
                Text("Scan the QR code Yo shows on your computer, or paste your phone link.")
                    .font(.geist(15))
                    .foregroundStyle(Palette.muted)
            }
            Button { showScanner = true } label: {
                Label("Scan QR code", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(YoButtonStyle(kind: .primary))
            .accessibilityIdentifier("scan")
            HStack(spacing: 8) {
                TextField("Paste your phone link", text: $linkText)
                    .font(.geist(16))
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($fieldFocused)
                    .onSubmit(connect)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 48)
                    .background(Palette.bg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(fieldFocused ? Palette.ink : Palette.line2))
                    .accessibilityIdentifier("link-field")
                if linkText.trimmingCharacters(in: .whitespaces).isEmpty {
                    // PasteButton reads the clipboard without iOS asking for permission.
                    PasteButton(payloadType: String.self) { strings in
                        if let text = strings.first { model.pair(text: text) }
                    }
                    .buttonBorderShape(.roundedRectangle(radius: 14))
                    .tint(Palette.ink)
                    .labelStyle(.titleAndIcon)
                    .controlSize(.large)
                } else {
                    Button("Connect", action: connect)
                        .buttonStyle(YoButtonStyle(kind: .ink, minHeight: 48))
                        .fixedSize()
                        .accessibilityIdentifier("connect")
                }
            }
            if let error = model.pairingError {
                Text(error)
                    .font(.geist(14))
                    .foregroundStyle(Palette.red)
                    .accessibilityIdentifier("pairing-error")
            }
        }
        .padding(18)
        .yoCard()
    }

    private var finePrint: some View {
        VStack(spacing: 14) {
            Label {
                Text("This link is your Yo in your pocket. Keep it to yourself: anyone with it can talk to Yo as you, including your chats, files and approvals.")
            } icon: {
                Image(systemName: "lock.fill")
            }
            Link("Privacy Policy", destination: AppModel.privacyURL)
                .fontWeight(.semibold)
                .foregroundStyle(Palette.fg2)
        }
        .font(.geist(13, relativeTo: .footnote))
        .foregroundStyle(Palette.muted)
        .padding(.horizontal, 8)
        .padding(.top, 4)
    }

    private func connect() {
        if model.pair(text: linkText) { linkText = "" }
    }
}

/// How to get a phone link (docs/phone/GUIDE.md).
struct LinkHelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("A phone link connects this iPhone to your Yo. You make it in Yo on your computer.")
                        .font(.geist(17))
                        .foregroundStyle(Palette.fg2)
                    VStack(alignment: .leading, spacing: 0) {
                        step(1, "On your computer, open **Yo** and go to **Settings → Phone**.")
                        Divider().overlay(Palette.line)
                        step(2, "Tap **Create phone link**.")
                        Divider().overlay(Palette.line)
                        step(3, "Scan the QR code with this iPhone. Or tap **Copy link**, send it to yourself (a note or a text to your own number), and paste it here.")
                    }
                    .padding(.horizontal, 16)
                    .yoCard()
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Or let Yo do it")
                            .font(.geist(17, .semibold))
                        Text("Ask Yo: *“Set up Yo Phone on my phone.”* It asks for your OK first, then the link appears in Settings → Phone. Yo itself never sees the link.")
                            .font(.geist(15))
                            .foregroundStyle(Palette.fg2)
                    }
                    Label {
                        Text("Keep the link to yourself. Anyone with it can talk to Yo as you. You can turn it off anytime in Yo: Settings → Phone → Turn off.")
                    } icon: {
                        Image(systemName: "lock.fill")
                    }
                    .font(.geist(14, relativeTo: .footnote))
                    .foregroundStyle(Palette.muted)
                }
                .padding(20)
            }
            .background(Palette.bg)
            .navigationTitle("Get your link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(n)")
                .font(.geist(14, .semibold))
                .foregroundStyle(Palette.onYellow)
                .frame(width: 28, height: 28)
                .background(Palette.yellow, in: Circle())
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
                .accessibilityHidden(true)
            Text(text)
                .font(.geist(16))
                .foregroundStyle(Palette.fg2)
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}
