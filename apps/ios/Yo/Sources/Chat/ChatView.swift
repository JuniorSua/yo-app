import SwiftUI
import YoPhoneKit

/// The conversation with Yo: header, messages, cards, Yo's working row, and the composer or Drive panel.
struct ChatView: View {
    let session: PhoneSession
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if session.items.isEmpty { EmptyChat(agentName: session.agentName, isDemo: model.isDemo) }
                    ForEach(ThreadLayout.rows(for: session.items)) { row in
                        ThreadRowView(row: row, session: session, large: model.drive.isOn)
                            .id(row.id)
                    }
                    if let text = session.workingText {
                        WorkingRow(text: text, canStop: session.working?.state == .working,
                                   stopping: session.working?.stopping == true) {
                            Task { await session.stop() }
                        }
                        .id(Self.workingID)
                    }
                    Color.clear.frame(height: 1).id(Self.bottomID)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .animation(.snappy(duration: 0.28), value: session.items.count)
                .animation(.snappy(duration: 0.28), value: session.workingText)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: session.items.last?.key) { scrollDown(proxy) }
            .onChange(of: session.workingText == nil) { scrollDown(proxy) }
            .onChange(of: model.drive.isOn) { scrollDown(proxy) }
        }
        .background(Palette.bg)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                ChatHeader(session: session)
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    if let banner = session.bannerText(at: context.date) {
                        Text(banner)
                            .font(.geist(13.5, relativeTo: .footnote))
                            .foregroundStyle(Palette.fg2)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 9)
                            .background(Palette.bg2)
                            .overlay(alignment: .bottom) { Palette.line.frame(height: 1) }
                            .accessibilityIdentifier("banner")
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.drive.isOn {
                DrivePanel(drive: model.drive)
            } else {
                Composer(agentName: session.agentName) { text in
                    Task { await session.send(text) }
                }
            }
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView(session: session)
        }
    }

    private static let workingID = "working"
    private static let bottomID = "bottom"

    private func scrollDown(_ proxy: ScrollViewProxy) {
        withAnimation(.snappy) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
    }
}

private struct EmptyChat: View {
    let agentName: String
    let isDemo: Bool

    var body: some View {
        VStack(spacing: 12) {
            Image("Logo")
                .resizable()
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)
            Text(isDemo
                ? "This is the demo: a pretend Yo on this iPhone, and nothing leaves it. Try “Book a table for 4 on Friday”."
                : "Say hi. \(agentName) can research, plan, remind and get things done for you.")
                .font(.geist(15))
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: 280)
        .padding(.vertical, 120)
    }
}

/// One row of the thread.
private struct ThreadRowView: View {
    let row: ThreadRow
    let session: PhoneSession
    let large: Bool

    var body: some View {
        switch row.content {
        case let .timestamp(day, time):
            Text("\(Text(day).fontWeight(.semibold)) \(time)")
                .font(.geist(12, .medium, relativeTo: .caption))
                .foregroundStyle(Palette.muted)
                .padding(.top, 14)
                .padding(.bottom, 8)
                .accessibilityAddTraits(.isHeader)
        case let .bubble(item, first, _, meta):
            MessageBubble(item: item, first: first, meta: meta, agentName: session.agentName, large: large) {
                Task { await session.retry(item.id) }
            }
        case let .card(item):
            RequestCardView(item: item) { decision, answer in
                Task { await session.respond(to: item.id, decision: decision, answer: answer) }
            }
        case let .error(item):
            Text(item.text)
                .font(.geist(14))
                .foregroundStyle(Palette.red)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Palette.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .frame(maxWidth: 340)
                .padding(.top, 10)
                .padding(.bottom, 4)
                .accessibilityLabel("Error: \(item.text)")
        }
    }
}
