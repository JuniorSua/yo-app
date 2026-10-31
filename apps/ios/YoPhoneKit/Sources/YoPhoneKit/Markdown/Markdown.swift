import Foundation

/// A block of one of Yo's replies.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(AttributedString)
    case list(ordered: Bool, start: Int, items: [AttributedString])
    case code(String)
}

/// The same light Markdown as phone/lib/markdown.js: bold, italics, strikethrough, inline code, code blocks,
/// http(s) links (written or bare), bullet and numbered lists, and headings shown as bold paragraphs. Pictures
/// (`![alt](src)`) show as an italic "Picture: alt" note, since this app doesn't load them.
/// Inline styles are Foundation presentation intents, which SwiftUI's `Text` draws.
public enum Markdown {
    public static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var para: [String] = []
        var list: (ordered: Bool, start: Int, items: [String])?

        func flushPara() {
            if !para.isEmpty {
                var joined = AttributedString()
                for (i, line) in para.enumerated() {
                    if i > 0 { joined += AttributedString("\n") }
                    joined += inline(line)
                }
                blocks.append(.paragraph(joined))
            }
            para = []
        }
        func flushList() {
            if let list { blocks.append(.list(ordered: list.ordered, start: list.start, items: list.items.map(inline))) }
            list = nil
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            if fence.matches(line) {
                flushPara()
                flushList()
                var code: [String] = []
                i += 1
                while i < lines.count, !fence.matches(lines[i]) {
                    code.append(lines[i])
                    i += 1
                }
                blocks.append(.code(code.joined(separator: "\n")))
                i += 1
                continue
            }
            defer { i += 1 }
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flushPara()
                flushList()
                continue
            }
            let bullet = bulletLine.groups(line)
            let number = numberLine.groups(line)
            if bullet != nil || number != nil {
                flushPara()
                let ordered = bullet == nil
                if list?.ordered != ordered {
                    flushList()
                    list = (ordered, number.flatMap { Int($0[0]) } ?? 1, [])
                }
                list?.items.append(bullet?[0] ?? number![1])
                continue
            }
            if list != nil, continuation.matches(line) {
                list!.items[list!.items.count - 1] += " " + line.trimmingCharacters(in: .whitespaces)
                continue
            }
            flushList()
            if let heading = headingLine.groups(line) {
                flushPara()
                var bold = inline(heading[0])
                for run in bold.runs {
                    bold[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(.stronglyEmphasized)
                }
                blocks.append(.paragraph(bold))
                continue
            }
            para.append(line)
        }
        flushPara()
        flushList()
        return blocks
    }

    /// Plain text for reading aloud: no markup, links read as their label.
    public static func speech(_ text: String) -> String {
        var s = text
        s = s.jsReplace(#"```[\s\S]*?```"#, with: " (code) ")
        s = s.jsReplace(#"!\[([^\]]*)\]\([^)]*\)"#, with: " (picture) $1 ")
        s = s.jsReplace(#"\[([^\]]+)\]\([^)]+\)"#, with: "$1")
        s = s.jsReplace(#"https?://\S+"#, with: "a link")
        s = s.jsReplace(#"[*_~`#>]+"#, with: "")
        s = s.jsReplace(#"^\s*[-•]\s+"#, with: "", options: .anchorsMatchLines)
        s = s.jsReplace(#"\s+"#, with: " ")
        return s.trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Inline

    private static let fence = Pattern(#"^\s*```"#)
    private static let bulletLine = Pattern(#"^\s*[-*•]\s+(.*)$"#)
    private static let numberLine = Pattern(#"^\s*(\d{1,3})[.)]\s+(.*)$"#)
    private static let headingLine = Pattern(#"^\s*#{1,6}\s+(.*)$"#)
    private static let continuation = Pattern(#"^\s{2,}\S"#)

    // Private-use characters stand in for held spans and style markers while the regexes run, the same way the
    // PWA holds code and links aside before it styles the rest.
    private static let holdOpen: Character = "\u{E000}"
    private static let holdClose: Character = "\u{E001}"
    private static let markers: [(open: Character, close: Character, intent: InlinePresentationIntent)] = [
        ("\u{E010}", "\u{E011}", .stronglyEmphasized),
        ("\u{E012}", "\u{E013}", .emphasized),
        ("\u{E014}", "\u{E015}", .strikethrough),
    ]
    private static let w = "A-Za-z0-9_"

    static func inline(_ raw: String) -> AttributedString {
        var held: [AttributedString] = []
        func hold(_ span: AttributedString) -> String {
            held.append(span)
            return "\(holdOpen)\(held.count - 1)\(holdClose)"
        }
        var s = String(raw.unicodeScalars.filter { !(0xE000...0xE0FF).contains($0.value) }.map(Character.init))
        s = s.jsReplace(#"`([^`\n]+)`"#) { g in
            var code = AttributedString(g[1])
            code.inlinePresentationIntent = .code
            return hold(code)
        }
        // This app doesn't show pictures (`![alt](src)`) yet, so say there's one instead of showing the markup.
        s = s.jsReplace(#"!\[([^\]\n\#(holdOpen)]*)\]\(([^)\n]*)\)"#) { g in
            let alt = g[1].trimmingCharacters(in: .whitespaces)
            var note = AttributedString(alt.isEmpty ? "Picture in Yo" : "Picture: \(alt)")
            note.inlinePresentationIntent = .emphasized
            return hold(note)
        }
        s = s.jsReplace(#"\[([^\]\n]+)\]\((https?://[^\s)]+)\)"#) { g in
            var label = styled(g[1], held: held)
            label.link = URL(string: g[2])
            return hold(label)
        }
        s = s.jsReplace(#"(?<![\#(w)])https?://[^\s<>()]+[^\s<>().,;:!?'"]"#) { g in
            var link = AttributedString(g[0])
            link.link = URL(string: g[0])
            return hold(link)
        }
        return styled(s, held: held)
    }

    /// Applies bold, italics and strikethrough (the PWA's `inlineText`), then swaps the held spans back in.
    private static func styled(_ text: String, held: [AttributedString]) -> AttributedString {
        let b = markers[0], i = markers[1], x = markers[2]
        var s = text
        s = s.jsReplace(#"\*\*(?=\S)([^*]+?)\*\*"#, with: "\(b.open)$1\(b.close)")
        s = s.jsReplace(#"(^|[^\#(w)])__(?=\S)([^_]+?)__(?![\#(w)])"#, with: "$1\(b.open)$2\(b.close)")
        s = s.jsReplace(#"(^|[^*\#(w)])\*(?=\S)([^*\n]+?)\*(?![\#(w)])"#, with: "$1\(i.open)$2\(i.close)")
        s = s.jsReplace(#"(^|[^\#(w)])_(?=\S)([^_\n]+?)_(?![\#(w)])"#, with: "$1\(i.open)$2\(i.close)")
        s = s.jsReplace(#"~~(?=\S)([^~]+?)~~"#, with: "\(x.open)$1\(x.close)")

        var out = AttributedString()
        var active: InlinePresentationIntent = []
        var buffer = ""
        var index: String?
        func flush() {
            guard !buffer.isEmpty else { return }
            var run = AttributedString(buffer)
            if !active.isEmpty { run.inlinePresentationIntent = active }
            out += run
            buffer = ""
        }
        for ch in s {
            if ch == holdOpen {
                flush()
                index = ""
            } else if ch == holdClose, let n = index.flatMap(Int.init), held.indices.contains(n) {
                var span = held[n]
                if !active.isEmpty {
                    for run in span.runs {
                        span[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(active)
                    }
                }
                out += span
                index = nil
            } else if index != nil {
                index!.append(ch)
            } else if let m = markers.first(where: { $0.open == ch || $0.close == ch }) {
                flush()
                if m.open == ch { active.insert(m.intent) } else { active.remove(m.intent) }
            } else {
                buffer.append(ch)
            }
        }
        flush()
        return out
    }
}

/// A compiled NSRegularExpression, which matches JavaScript's UTF-16 semantics more closely than Swift Regex.
struct Pattern: Sendable {
    let regex: NSRegularExpression

    init(_ pattern: String, options: NSRegularExpression.Options = []) {
        regex = try! NSRegularExpression(pattern: pattern, options: options)
    }

    func matches(_ s: String) -> Bool {
        regex.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// The capture groups of the first match.
    func groups(_ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (1..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }
}

extension String {
    /// Like JavaScript's `replace(/pattern/g, template)`, with `$1`-style templates.
    func jsReplace(_ pattern: String, with template: String, options: NSRegularExpression.Options = []) -> String {
        let regex = Pattern(pattern, options: options).regex
        return regex.stringByReplacingMatches(in: self, range: NSRange(location: 0, length: (self as NSString).length),
                                              withTemplate: template)
    }

    /// Like JavaScript's `replace(/pattern/g, fn)`: `transform` gets the whole match and every group.
    func jsReplace(_ pattern: String, transform: ([String]) -> String) -> String {
        let regex = Pattern(pattern).regex
        let ns = self as NSString
        var out = ""
        var last = 0
        for m in regex.matches(in: self, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let groups = (0..<m.numberOfRanges).map {
                m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0))
            }
            out += transform(groups)
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }
}
