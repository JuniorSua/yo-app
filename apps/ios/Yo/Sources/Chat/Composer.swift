import SwiftUI
import YoPhoneKit

/// The text box and send button.
struct Composer: View {
    let agentName: String
    let send: (String) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Text \(agentName)", text: $draft, axis: .vertical)
                .font(.geist(17))
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(focused ? Palette.faint : Palette.line2))
                .onChange(of: draft) { _, text in
                    if text.count > PhoneSession.maxTextLength { draft = String(text.prefix(PhoneSession.maxTextLength)) }
                }
                .accessibilityLabel("Message")
                .accessibilityIdentifier("composer")
            Button {
                let text = draft
                draft = ""
                send(text)
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(canSend ? Palette.onYellow : Palette.faint)
                    .frame(width: 44, height: 44)
                    .background(canSend ? Palette.yellow : Palette.bg3, in: Circle())
                    .shadow(color: canSend ? Palette.glow.opacity(0.45) : .clear, radius: 5, y: 2)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("send")
            .animation(.snappy(duration: 0.15), value: canSend)
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.bar)
        .overlay(alignment: .top) { Palette.line.frame(height: 1) }
    }
}
