import Foundation
import Testing
@testable import YoPhoneKit

/// Renders blocks as the PWA's HTML so these tests can mirror phone/test/markdown.test.js.
private func html(_ text: String) -> String {
    Markdown.parse(text).map { block in
        switch block {
        case let .paragraph(s): "<p>\(inline(s))</p>"
        case let .list(ordered, start, items):
            (ordered ? (start == 1 ? "<ol>" : "<ol start=\"\(start)\">") : "<ul>")
                + items.map { "<li>\(inline($0))</li>" }.joined() + (ordered ? "</ol>" : "</ul>")
        case let .code(code): "<pre><code>\(code)</code></pre>"
        }
    }.joined()
}

private func inline(_ s: AttributedString) -> String {
    s.runs.map { run in
        var text = String(s[run.range].characters).replacingOccurrences(of: "\n", with: "<br>")
        let intent = run.inlinePresentationIntent ?? []
        if intent.contains(.code) { text = "<code>\(text)</code>" }
        if intent.contains(.strikethrough) { text = "<s>\(text)</s>" }
        if intent.contains(.emphasized) { text = "<em>\(text)</em>" }
        if intent.contains(.stronglyEmphasized) { text = "<strong>\(text)</strong>" }
        if let link = run.link { text = "<a href=\"\(link.absoluteString)\">\(text)</a>" }
        return text
    }.joined()
}

@Suite struct MarkdownTests {
    @Test func keepsHTMLAsText() {
        #expect(html("<img src=x onerror=\"alert(1)\"> & <b>") == "<p><img src=x onerror=\"alert(1)\"> & <b></p>")
    }

    @Test func boldItalicsCodeAndLinks() {
        let out = html("**bold** and *it* and _it2_ and `x<y` see [docs](https://example.com/a?b=1&c=2)")
        #expect(out.contains("<strong>bold</strong>"))
        #expect(out.contains("<em>it</em>"))
        #expect(out.contains("<em>it2</em>"))
        #expect(out.contains("<code>x<y</code>"))
        #expect(out.contains("<a href=\"https://example.com/a?b=1&c=2\">docs</a>"))
        #expect(html("~~gone~~") == "<p><s>gone</s></p>")
        #expect(html("__strong__") == "<p><strong>strong</strong></p>")
    }

    @Test func onlyLinksHTTP() {
        #expect(!html("[x](javascript:alert(1)) [y](data:text/html,hi)").contains("<a"))
    }

    @Test func autolinksBareURLsWithoutTrailingPunctuation() {
        #expect(html("go to https://yo.example/x.") == "<p>go to <a href=\"https://yo.example/x\">https://yo.example/x</a>.</p>")
    }

    @Test func leavesSnakeCaseAlone() {
        #expect(html("my_var_name") == "<p>my_var_name</p>")
        #expect(html("2*3*4") == "<p>2*3*4</p>")
    }

    @Test func listsParagraphsAndCodeBlocks() {
        #expect(html("Hi\nthere\n\n- one\n- **two**\n\n1. a\n2. b\n\n```\n<b>raw</b>\n```")
            == "<p>Hi<br>there</p><ul><li>one</li><li><strong>two</strong></li></ul><ol><li>a</li><li>b</li></ol><pre><code><b>raw</b></code></pre>")
    }

    @Test func headingsNumberedStartsAndContinuations() {
        #expect(html("## Plan *today*") == "<p><strong>Plan </strong><strong><em>today</em></strong></p>")
        #expect(html("3. c\n4. d") == "<ol start=\"3\"><li>c</li><li>d</li></ol>")
        #expect(html("- one\n  more\n- two") == "<ul><li>one more</li><li>two</li></ul>")
    }

    @Test func styleWrapsHeldLinks() {
        #expect(html("**see [docs](https://a.b)**") == "<p><strong>see </strong><a href=\"https://a.b\"><strong>docs</strong></a></p>")
    }

    @Test func speechStripsMarkup() {
        #expect(Markdown.speech("**Done.** See [the doc](https://x.y) and https://a.b/c\n- one") == "Done. See the doc and a link one")
        #expect(Markdown.speech("Run:\n```\nls -la\n```\nok") == "Run: (code) ok")
    }
}

@Suite struct ThreadLayoutTests {
    let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }()
    let locale = Locale(identifier: "en_US")

    private func at(_ minute: Int, day: Int = 8) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: 9, minute: minute))!
    }

    @Test func groupsBubblesAndStampsTime() {
        let items: [ChatItem] = [
            .mine(id: "a", text: "1", at: at(0), delivery: .delivered),
            .mine(id: "b", text: "2", at: at(1), delivery: .delivered),
            .yo(id: "c", text: "3", at: at(2)),
            .mine(id: "d", text: "4", at: at(30), delivery: .sent),
        ]
        let rows = ThreadLayout.rows(for: items, now: at(40), calendar: calendar, locale: locale)
        #expect(rows.count == 6)
        #expect(rows[0].content == .timestamp(day: "Today", time: "9:00\u{202F}AM"))
        guard case let .bubble(_, first, last, meta) = rows[1].content else { Issue.record("not a bubble"); return }
        #expect(first && !last && meta == nil)
        guard case let .bubble(_, first2, last2, meta2) = rows[2].content else { Issue.record("not a bubble"); return }
        #expect(!first2 && last2)
        // Delivery shows only under the owner's latest message.
        #expect(meta2 == ThreadRow.Meta(time: "9:01\u{202F}AM", delivery: nil))
        #expect(rows[4].content == .timestamp(day: "Today", time: "9:30\u{202F}AM"))
        guard case let .bubble(_, _, _, meta4) = rows[5].content else { Issue.record("not a bubble"); return }
        #expect(meta4 == ThreadRow.Meta(time: "9:30\u{202F}AM", delivery: .sent))
    }

    @Test func failedMessagesOfferRetryAndCardsBreakGroups() {
        var failed = ChatItem.mine(id: "f", text: "x", at: at(0), delivery: .failed)
        failed.failure = "No connection."
        let items: [ChatItem] = [
            failed,
            .card(RequestCard(requestId: "q", kind: .approval, title: "OK?"), at: at(0)),
            .error(id: "e", text: "Something went wrong", at: at(0)),
        ]
        let rows = ThreadLayout.rows(for: items, now: at(1), calendar: calendar, locale: locale)
        guard case let .bubble(_, _, last, meta) = rows[1].content else { Issue.record("not a bubble"); return }
        #expect(last && meta == ThreadRow.Meta(failure: "No connection."))
        #expect(rows[2].content == .card(items[1]))
        #expect(rows[3].content == .error(items[2]))
    }

    @Test func dayLabels() {
        let now = at(0, day: 8)
        #expect(ThreadLayout.dayLabel(at(0, day: 7), now: now, calendar: calendar, locale: locale) == "Yesterday")
        #expect(ThreadLayout.dayLabel(at(0, day: 5), now: now, calendar: calendar, locale: locale) == "Monday")
        #expect(ThreadLayout.dayLabel(at(0, day: 1), now: now, calendar: calendar, locale: locale) == "Oct 1")
    }
}
