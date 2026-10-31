import Foundation

/// One row of the conversation as the PWA lays it out: time stamps between bursts, bubbles grouped by sender,
/// and the time plus Sent/Delivered under the last bubble of a group.
public struct ThreadRow: Identifiable, Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case timestamp(day: String, time: String)
        case bubble(ChatItem, first: Bool, last: Bool, meta: Meta?)
        case card(ChatItem)
        case error(ChatItem)
    }

    public struct Meta: Equatable, Sendable {
        public var time: String?
        /// "Sending…", "Sent" or "Delivered", only under the owner's latest message.
        public var delivery: ChatItem.Delivery?
        /// Why it didn't send; the row offers Retry.
        public var failure: String?
    }

    public let id: String
    public let content: Content
}

public enum ThreadLayout {
    static let gap: TimeInterval = 15 * 60
    static let groupWindow: TimeInterval = 3 * 60

    public static func rows(for items: [ChatItem], now: Date = Date(), calendar: Calendar = .current,
                            locale: Locale = .current) -> [ThreadRow] {
        var timeStyle = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar)
        timeStyle.timeZone = calendar.timeZone
        let lastMine = items.last { $0.kind == .mine }?.id
        var rows: [ThreadRow] = []
        var prev: ChatItem?
        var lastAt: Date?

        func same(_ a: ChatItem?, _ b: ChatItem?) -> Bool {
            guard let a, let b else { return false }
            return a.kind == b.kind && abs(b.at.timeIntervalSince(a.at)) < groupWindow
        }

        for (i, item) in items.enumerated() {
            let next = i + 1 < items.count ? items[i + 1] : nil
            if lastAt == nil || item.at.timeIntervalSince(lastAt!) > gap
                || dayLabel(item.at, now: now, calendar: calendar, locale: locale)
                != dayLabel(lastAt!, now: now, calendar: calendar, locale: locale) {
                rows.append(ThreadRow(
                    id: "when:\(item.key)",
                    content: .timestamp(day: dayLabel(item.at, now: now, calendar: calendar, locale: locale),
                                        time: item.at.formatted(timeStyle))
                ))
                prev = nil
            }
            switch item.kind {
            case .mine, .yo:
                let failed = item.delivery == .failed
                let first = !same(prev, item)
                let last = !same(item, next) || (next?.kind == .mine && next?.delivery == .failed) || failed
                var meta: ThreadRow.Meta?
                if item.kind == .mine && failed {
                    meta = ThreadRow.Meta(failure: item.failure ?? ChatItem.Delivery.failed.label)
                } else if last {
                    let showsDelivery = item.kind == .mine && (item.id == lastMine || item.delivery == .sending)
                    meta = ThreadRow.Meta(time: item.at.formatted(timeStyle),
                                          delivery: showsDelivery ? item.delivery : nil)
                }
                rows.append(ThreadRow(id: item.key, content: .bubble(item, first: first, last: last, meta: meta)))
                prev = item
            case .card:
                rows.append(ThreadRow(id: item.key, content: .card(item)))
                prev = nil
            case .error:
                rows.append(ThreadRow(id: item.key, content: .error(item)))
                prev = nil
            }
            lastAt = item.at
        }
        return rows
    }

    /// "Today", "Yesterday", a weekday within the week, else "Oct 3".
    public static func dayLabel(_ date: Date, now: Date, calendar: Calendar = .current,
                                locale: Locale = .current) -> String {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date),
                                           to: calendar.startOfDay(for: now)).day ?? 0
        var style = Date.FormatStyle(locale: locale, calendar: calendar)
        style.timeZone = calendar.timeZone
        switch days {
        case 0: return "Today"
        case 1: return "Yesterday"
        case 2..<7: return date.formatted(style.weekday(.wide))
        default: return date.formatted(style.month(.abbreviated).day())
        }
    }
}
