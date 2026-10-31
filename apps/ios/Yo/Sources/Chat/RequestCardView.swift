import SwiftUI
import YoPhoneKit

/// An approval, question or open-Yo card, and its answer once it's resolved.
struct RequestCardView: View {
    let item: ChatItem
    let respond: (InMessage.Decision, String?) -> Void

    private var card: RequestCard { item.card ?? RequestCard(requestId: item.id, kind: .approval, title: item.text) }
    private var resolved: Bool { item.outcome != nil }

    private var kicker: String {
        if resolved { return "Answered" }
        switch card.kind {
        case .question: return "Question"
        case .openYo: return "Needs your computer"
        case .approval: return "Needs your OK"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Circle()
                    .fill(resolved ? Palette.faint : Palette.yellow2)
                    .frame(width: 8, height: 8)
                Text(kicker)
                    .font(.geist(12.5, .semibold, relativeTo: .caption))
                    .textCase(.uppercase)
                    .tracking(0.3)
                    .foregroundStyle(resolved ? Palette.muted : Palette.yellowInk)
            }
            Text(card.title)
                .font(.geist(17, .semibold, relativeTo: .headline))
                .padding(.top, 6)
            if !card.detail.isEmpty {
                Text(card.detail)
                    .font(.geist(15, relativeTo: .subheadline))
                    .foregroundStyle(Palette.fg2)
                    .padding(.top, 6)
            }
            actions
                .padding(.top, resolved ? 12 : 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .yoCard()
        .frame(maxWidth: 440)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(kicker): \(card.title)")
        .sensoryFeedback(.success, trigger: item.outcome) { _, new in new != nil }
    }

    @ViewBuilder
    private var actions: some View {
        if let outcome = item.outcome {
            Label {
                Text(outcome).font(.geist(15, .semibold))
            } icon: {
                Image(systemName: "checkmark").fontWeight(.bold).foregroundStyle(Palette.green)
            }
            .foregroundStyle(Palette.fg2)
            .accessibilityIdentifier("card-outcome")
        } else {
            switch card.kind {
            case .openYo:
                note("Open Yo on your computer")
            case .question where card.options.isEmpty:
                note("Answer this in Yo on your computer")
            case .question:
                VStack(spacing: 8) {
                    ForEach(Array(card.options.enumerated()), id: \.offset) { i, option in
                        Button(item.pending == option ? "Sending…" : option) { respond(.approve, option) }
                            .buttonStyle(YoButtonStyle(kind: i == 0 ? .primary : .plain))
                    }
                }
                .disabled(item.pending != nil)
            case .approval:
                HStack(spacing: 8) {
                    Button(item.pending == "deny" ? "Sending…" : "Deny") { respond(.deny, nil) }
                        .buttonStyle(YoButtonStyle(kind: .plain))
                        .accessibilityIdentifier("deny")
                    Button(item.pending == "approve" ? "Sending…" : "Approve") { respond(.approve, nil) }
                        .buttonStyle(YoButtonStyle(kind: .primary))
                        .accessibilityIdentifier("approve")
                }
                .disabled(item.pending != nil)
            }
        }
    }

    private func note(_ text: String) -> some View {
        Label(text, systemImage: "laptopcomputer")
            .font(.geist(14.5, .medium))
            .foregroundStyle(Palette.fg2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Palette.bg2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Yo's typing indicator with what it's doing, and Stop.
struct WorkingRow: View {
    let text: String
    let canStop: Bool
    let stopping: Bool
    let stop: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            TypingDots()
            Text(text)
                .font(.geist(13.5, relativeTo: .footnote))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("working-text")
            if canStop {
                Button(action: stop) {
                    Label("Stop", systemImage: "stop.fill")
                        .font(.geist(14, .semibold, relativeTo: .subheadline))
                        .labelStyle(StopLabelStyle())
                        .padding(.horizontal, 14)
                        .frame(minHeight: 36)
                        .background(Palette.card, in: Capsule())
                        .overlay(Capsule().strokeBorder(Palette.line2))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(stopping)
                .opacity(stopping ? 0.55 : 1)
                .accessibilityIdentifier("stop")
            }
        }
        .padding(.top, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(text)
    }
}

private struct StopLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.font(.system(size: 11))
            configuration.title
        }
    }
}

/// Three dots bouncing in a Yo bubble.
private struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    let phase = (t / 1.3 - Double(i) * 0.14).truncatingRemainder(dividingBy: 1)
                    let lift = phase < 0.3 ? sin(phase / 0.3 * .pi) : 0
                    Circle()
                        .fill(Palette.muted)
                        .frame(width: 8, height: 8)
                        .opacity(0.35 + 0.65 * lift)
                        .offset(y: -3 * lift)
                }
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
        .background(Palette.bubbleYo, in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6,
                                                                bottomTrailingRadius: 20, topTrailingRadius: 20))
        .accessibilityHidden(true)
    }
}
