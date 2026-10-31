import SwiftUI
import YoPhoneKit

/// Shown once, before the first pairing: where messages go (App Review guideline 5.1.2(i), third-party AI).
struct AINoticeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            content
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Palette.bg)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image("Logo")
                .resizable()
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
            Text("Where your messages go")
                .font(.geist(26, .semibold, relativeTo: .title))
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 14) {
                point("laptopcomputer", "Messages you send here go to **your own Yo** on your computer, end-to-end encrypted.")
                point("sparkles", "Your Yo answers using the **AI service you chose** in Yo, such as Claude or ChatGPT, under that service's terms.")
                point("lock.fill", "This app sends nothing to an AI service itself, and there's no Yo account.")
            }
            Link("Privacy Policy", destination: AppModel.privacyURL)
                .font(.geist(15, .semibold))
                .foregroundStyle(Palette.fg2)
            Button("OK") { model.acknowledgeNotice() }
                .buttonStyle(YoButtonStyle(kind: .ink))
                .padding(.top, 12)
                .accessibilityIdentifier("notice-ok")
            Button("Not now") { model.linkAwaitingNotice = nil }
                .buttonStyle(YoButtonStyle(kind: .plain))
        }
        .padding(24)
        .padding(.top, 32)
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity)
    }

    private func point(_ icon: String, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(Palette.yellowInk)
                .frame(width: 22)
                .accessibilityHidden(true)
            Text(text)
                .font(.geist(17))
                .foregroundStyle(Palette.fg2)
        }
    }
}
