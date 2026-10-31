import SwiftUI
import UIKit
import YoPhoneKit

/// The owner's yellow bubble or Yo's paper bubble, with time and Sent/Delivered under the last of a group.
struct MessageBubble: View {
    let item: ChatItem
    let first: Bool
    let meta: ThreadRow.Meta?
    let agentName: String
    /// Drive mode: bigger text.
    let large: Bool
    let retry: () -> Void

    private var mine: Bool { item.kind == .mine }

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            bubble
            if let meta { MetaLine(meta: meta, retry: retry) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, 48)
        .padding(.top, first ? 8 : 2)
    }

    private var bubble: some View {
        Group {
            if mine {
                Text(item.text)
                    .font(.geist(large ? 19 : 17))
            } else {
                MarkdownText(text: item.text, size: large ? 19 : 17)
            }
        }
        .foregroundStyle(mine ? Palette.onYellow : Palette.ink)
        .tint(mine ? Palette.onYellow : Palette.link)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(mine ? Palette.yellow : Palette.bubbleYo, in: shape)
        .opacity(item.delivery == .failed ? 0.6 : 1)
        .contentShape(.contextMenuPreview, shape)
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = item.text }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(mine ? "You" : agentName): \(Markdown.speech(item.text))")
    }

    private var shape: UnevenRoundedRectangle {
        let big: CGFloat = 20
        let small: CGFloat = 6
        return mine
            ? UnevenRoundedRectangle(topLeadingRadius: big, bottomLeadingRadius: big, bottomTrailingRadius: small,
                                     topTrailingRadius: first ? big : small, style: .continuous)
            : UnevenRoundedRectangle(topLeadingRadius: first ? big : small, bottomLeadingRadius: small,
                                     bottomTrailingRadius: big, topTrailingRadius: big, style: .continuous)
    }
}

private struct MetaLine: View {
    let meta: ThreadRow.Meta
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let failure = meta.failure {
                Text(failure)
                    .fontWeight(.medium)
                    .foregroundStyle(Palette.red)
                Button(action: retry) {
                    Text("Retry")
                        .font(.geist(13, .semibold, relativeTo: .caption))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 32)
                        .overlay(Capsule().strokeBorder(Palette.red.opacity(0.4)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.red)
                .accessibilityIdentifier("retry")
            } else {
                if let time = meta.time { Text(time) }
                if let delivery = meta.delivery {
                    Text("·").accessibilityHidden(true)
                    Text(delivery.label)
                        .fontWeight(.medium)
                        .foregroundStyle(delivery == .delivered ? Palette.fg2 : Palette.muted)
                        .accessibilityIdentifier("delivery")
                }
            }
        }
        .font(.geist(12, relativeTo: .caption))
        .monospacedDigit()
        .foregroundStyle(Palette.muted)
        .padding(.horizontal, 6)
    }
}

/// Yo's Markdown (YoPhoneKit's `Markdown`): paragraphs, lists and code blocks.
struct MarkdownText: View {
    let text: String
    let size: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Markdown.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case let .paragraph(content):
                    Text(content)
                case let .list(ordered, start, items):
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(items.enumerated()), id: \.offset) { i, content in
                            HStack(alignment: .firstTextBaseline, spacing: 7) {
                                Text(ordered ? "\(start + i)." : "•")
                                    .monospacedDigit()
                                    .foregroundStyle(Palette.fg2)
                                Text(content)
                            }
                        }
                    }
                case let .code(code):
                    CodeBlock(code: code)
                }
            }
        }
        .font(.geist(size))
        .textSelection(.enabled)
    }
}

/// A code block that scrolls sideways, with a Copy button (like the PWA's).
private struct CodeBlock: View {
    let code: String
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.geistMono(13.5, relativeTo: .callout))
                .fixedSize()
                .padding(.trailing, 36)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(white: 0.5).opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .topTrailing) {
            Button {
                UIPasteboard.general.string = code
                copied = true
                UIAccessibility.post(notification: .announcement, argument: "Copied")
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(copied ? Palette.green : Palette.fg2)
                    .frame(width: 32, height: 32)
                    .background(Palette.card.opacity(0.9), in: RoundedRectangle(cornerRadius: 8))
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.plain)
            .padding(4)
            .accessibilityLabel(copied ? "Copied" : "Copy code")
            .sensoryFeedback(.success, trigger: copied) { _, new in new }
        }
        .textSelection(.disabled)
    }
}
