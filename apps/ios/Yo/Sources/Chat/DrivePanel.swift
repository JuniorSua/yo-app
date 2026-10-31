import SwiftUI

/// Drive mode's big microphone, live transcript, and the 3-second countdown you can tap to cancel.
struct DrivePanel: View {
    let drive: DriveController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 12) {
            if !drive.transcript.isEmpty {
                Text(drive.transcript)
                    .font(.geist(20, .medium, relativeTo: .title3))
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("drive-transcript")
            }
            if case let .countdown(left) = drive.phase {
                countdown(left)
            } else {
                Text(drive.hint)
                    .font(.geist(16, .medium))
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("drive-hint")
                mic
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(.bar)
        .overlay(alignment: .top) { Palette.line.frame(height: 1) }
    }

    private var mic: some View {
        let listening = drive.phase == .listening
        return Button(action: drive.micTapped) {
            ZStack {
                if listening && !reduceMotion { Ring() }
                Circle()
                    .fill(listening ? Palette.red : Palette.yellow)
                    .shadow(color: (listening ? Palette.red : Palette.glow).opacity(0.5), radius: 14, y: 10)
                Image(systemName: listening ? "stop.fill" : "mic.fill")
                    .font(.system(size: listening ? 38 : 44, weight: .semibold))
                    .foregroundStyle(listening ? .white : Palette.onYellow)
                    .contentTransition(.symbolEffect(.replace))
            }
            .frame(width: 112, height: 112)
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(listening ? "Stop and send" : "Start talking")
        .accessibilityIdentifier("mic")
        .sensoryFeedback(.impact, trigger: listening)
    }

    private func countdown(_ left: Int) -> some View {
        Button(action: drive.cancelCountdown) {
            HStack(spacing: 14) {
                ZStack {
                    Circle().stroke(Self.ring.opacity(0.22), lineWidth: 4)
                    TimelineView(.animation(paused: drive.countdownStarted == nil)) { context in
                        Circle()
                            .trim(from: 0, to: remaining(at: context.date, left: left))
                            .stroke(Self.ring, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    }
                }
                .frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sending in \(left)…")
                        .font(.geist(20, .semibold, relativeTo: .title3))
                    Text("Tap to cancel")
                        .font(.geist(15))
                        .opacity(0.9)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .foregroundStyle(Palette.bg)
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: 360, minHeight: 84)
            .background(Palette.ink, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("Sending in \(left) seconds. Tap to cancel")
        .accessibilityIdentifier("countdown")
    }

    /// Yo Yellow on the dark countdown; a deeper amber on the light one dark mode uses.
    private static let ring = Color(light: 0xFFD43B, dark: 0xD99A00)

    /// The share of the countdown still to go, for the draining ring.
    private func remaining(at date: Date, left: Int) -> CGFloat {
        guard let started = drive.countdownStarted else {
            return CGFloat(left) / CGFloat(DriveController.countdownSeconds)
        }
        let total = Double(DriveController.countdownSeconds)
        return CGFloat(max(0, 1 - date.timeIntervalSince(started) / total))
    }
}

private struct Ring: View {
    @State private var expanded = false

    var body: some View {
        Circle()
            .stroke(Palette.red, lineWidth: 3)
            .padding(-8)
            .scaleEffect(expanded ? 1.18 : 0.92)
            .opacity(expanded ? 0 : 0.7)
            .onAppear {
                withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { expanded = true }
            }
    }
}

private struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}
