import SwiftUI
import YoPhoneKit

/// Yo's avatar, name and presence, with the Drive toggle and settings.
struct ChatHeader: View {
    let session: PhoneSession
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 4) {
            HStack(spacing: 10) {
                Image("Logo")
                    .resizable()
                    .frame(width: 40, height: 40)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(session.agentName)
                            .font(.geist(17, .semibold, relativeTo: .headline))
                            .lineLimit(1)
                            .accessibilityAddTraits(.isHeader)
                        if model.mode == .demo {
                            Text("Demo")
                                .font(.geist(11, .semibold, relativeTo: .caption2))
                                .textCase(.uppercase)
                                .foregroundStyle(Palette.yellowInk)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Palette.yellow.opacity(0.25), in: Capsule())
                                .accessibilityLabel("Demo")
                        }
                    }
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        PresenceLine(session: session, now: context.date)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                model.drive.setOn(!model.drive.isOn)
            } label: {
                Label("Drive", systemImage: "car.fill")
                    .font(.geist(14, .semibold, relativeTo: .subheadline))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 40)
                    .foregroundStyle(model.drive.isOn ? Palette.onYellow : Palette.ink)
                    .background(model.drive.isOn ? Palette.yellow : Color.clear, in: Capsule())
                    .overlay(Capsule().strokeBorder(model.drive.isOn ? Palette.yellow2 : Palette.line2))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.drive.isOn ? "Hands-free mode on. Turn off" : "Hands-free mode")
            .accessibilityIdentifier("drive-toggle")
            .sensoryFeedback(.selection, trigger: model.drive.isOn)

            Button {
                model.showSettings = true
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 20, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settings-button")
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        // Mostly opaque, so bright bubbles scrolling underneath don't tint the status bar.
        .background(Palette.bg.opacity(0.88), ignoresSafeAreaEdges: .top)
        .background(.bar, ignoresSafeAreaEdges: .top)
        .overlay(alignment: .bottom) { Palette.line.frame(height: 1) }
    }
}

private struct PresenceLine: View {
    let session: PhoneSession
    let now: Date

    var body: some View {
        let online = session.isOnline(at: now)
        let working = session.working != nil && online
        HStack(spacing: 6) {
            Circle()
                .fill(working ? Palette.yellow2 : online ? Palette.green : Palette.faint)
                .frame(width: 8, height: 8)
                .background {
                    if online {
                        Circle()
                            .fill((working ? Palette.yellow2 : Palette.green).opacity(0.2))
                            .frame(width: 14, height: 14)
                    }
                }
            Text(session.statusText(at: now))
                .font(.geist(13, relativeTo: .footnote))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
                .accessibilityIdentifier("presence")
        }
    }
}
