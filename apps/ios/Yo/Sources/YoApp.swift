import SwiftUI

@main
struct YoApp: App {
    @State private var model: AppModel

    init() {
        // Start before the first view, so a link that opened the app is checked against the saved one.
        let model = AppModel()
        model.start(LaunchOptions())
        _model = State(initialValue: model)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        ZStack {
            if let session = model.session {
                ChatView(session: session)
                    .transition(.opacity)
            } else {
                WelcomeView()
                    .transition(.opacity)
            }
            // An overlay rather than a sheet, so it can follow the QR scanner's sheet without a clash.
            if model.linkAwaitingNotice != nil {
                AINoticeView()
                    .transition(.move(edge: .bottom))
                    .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.session == nil)
        .animation(.snappy, value: model.linkAwaitingNotice == nil)
        .font(.geist(17))
        .overlay(alignment: .bottom) { ToastView(text: model.toast) }
        .alert("Replace your phone link?", isPresented: Binding(
            get: { model.linkToConfirm != nil },
            set: { if !$0 { model.linkToConfirm = nil } }
        )) {
            Button("Replace", role: .destructive) { model.confirmReplacement() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This iPhone will switch to the new link and clear the messages from the old one.")
        }
        .onOpenURL { model.open($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { model.open(url) }
        }
        .onAppear { model.setActive(scenePhase == .active) }
        .onChange(of: scenePhase) { _, phase in model.setActive(phase == .active) }
    }
}

private struct ToastView: View {
    let text: String?

    var body: some View {
        ZStack {
            if let text {
                Text(text)
                    .font(.geist(15, .medium))
                    .foregroundStyle(Palette.bg)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Palette.ink, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .shadow(color: .black.opacity(0.2), radius: 16, y: 8)
                    .padding(.bottom, 96)
                    .padding(.horizontal, 20)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityAddTraits(.updatesFrequently)
                    .onAppear { UIAccessibility.post(notification: .announcement, argument: text) }
            }
        }
        .animation(.snappy, value: text)
    }
}
