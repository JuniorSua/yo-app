import { describe, expect, it } from "vitest";
import { imageSources, renderMarkdown, toSpeech } from "../lib/markdown.js";

describe("renderMarkdown", () => {
  it("escapes HTML", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> & <script>alert(1)</script>');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp;");
  });
  it("does bold, italics, code and links", () => {
    const html = renderMarkdown(
      "**bold** and *it* and _it2_ and `x<y` see [docs](https://example.com/a?b=1&c=2)",
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<em>it2</em>");
    expect(html).toContain("<code>x&lt;y</code>");
    expect(html).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });
  it("does strikethrough", () => {
    expect(renderMarkdown("~~old~~ new")).toBe("<p><s>old</s> new</p>");
  });
  it("only links http(s), mailto and tel", () => {
    const html = renderMarkdown("[x](javascript:alert(1)) [y](data:text/html,hi) [z](JaVaScRiPt:alert(1))");
    expect(html).not.toContain("<a");
  });
  it("links mailto and tel without opening a new tab", () => {
    const html = renderMarkdown("[mail](mailto:a@example.com) [call](tel:+15551234567)");
    expect(html).toContain('<a href="mailto:a@example.com">mail</a>');
    expect(html).toContain('<a href="tel:+15551234567">call</a>');
  });
  it("does autolinks and links with titles or parentheses", () => {
    expect(renderMarkdown("see <https://yo.example/a>")).toBe(
      '<p>see <a href="https://yo.example/a" target="_blank" rel="noopener noreferrer">https://yo.example/a</a></p>',
    );
    expect(renderMarkdown('[t](https://a.b/c "Title")')).toContain('href="https://a.b/c"');
    expect(renderMarkdown("[w](https://en.wikipedia.org/wiki/Yo_(app))")).toContain(
      'href="https://en.wikipedia.org/wiki/Yo_(app)"',
    );
  });
  it("autolinks bare urls without trailing punctuation", () => {
    expect(renderMarkdown("go to https://yo.example/x.")).toContain('href="https://yo.example/x"');
  });
  it("keeps code inside a link label", () => {
    expect(renderMarkdown("[`npm i`](https://x.y)")).toBe(
      '<p><a href="https://x.y" target="_blank" rel="noopener noreferrer"><code>npm i</code></a></p>',
    );
  });
  it("leaves snake_case alone", () => {
    expect(renderMarkdown("my_var_name")).toBe("<p>my_var_name</p>");
  });
  it("strips the internal hold character", () => {
    expect(renderMarkdown("a\u00000\u0000b `c`")).toBe("<p>a0b <code>c</code></p>");
  });
  it("renders lists, paragraphs and code blocks", () => {
    const html = renderMarkdown("Hi\nthere\n\n- one\n- **two**\n\n1. a\n2. b\n\n```\n<b>raw</b>\n```");
    expect(html).toBe(
      "<p>Hi<br>there</p><ul><li>one</li><li><strong>two</strong></li></ul><ol><li>a</li><li>b</li></ol><pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>",
    );
  });
  it("keeps an ordered list's start", () => {
    expect(renderMarkdown("3. c\n4. d")).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
  });
});

describe("headings, quotes and rules", () => {
  it("maps # and ## to h3, deeper to h4", () => {
    expect(renderMarkdown("# Big\n## Mid\n### Small ###\n#### Tiny")).toBe(
      "<h3>Big</h3><h3>Mid</h3><h4>Small</h4><h4>Tiny</h4>",
    );
    expect(renderMarkdown("Intro\n## Plan **now**\nText")).toBe(
      "<p>Intro</p><h3>Plan <strong>now</strong></h3><p>Text</p>",
    );
    expect(renderMarkdown("## C#")).toBe("<h3>C#</h3>");
  });
  it("merges blockquote lines", () => {
    expect(renderMarkdown("> one *two*\n> three\n\nafter")).toBe(
      "<blockquote><p>one <em>two</em><br>three</p></blockquote><p>after</p>",
    );
    expect(renderMarkdown("> a\n>\n> - b")).toBe("<blockquote><p>a</p><ul><li>b</li></ul></blockquote>");
  });
  it("renders horizontal rules", () => {
    expect(renderMarkdown("a\n\n---\n\nb\n***\n___")).toBe("<p>a</p><hr><p>b</p><hr><hr>");
    expect(renderMarkdown("- - -")).toBe("<hr>");
  });
});

describe("lists", () => {
  it("nests one level by indentation", () => {
    expect(renderMarkdown("- a\n  - a1\n  - a2\n- b\n\t1. b1")).toBe(
      "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b<ol><li>b1</li></ol></li></ul>",
    );
    expect(renderMarkdown("1. one\n   - x\n2. two")).toBe(
      "<ol><li>one<ul><li>x</li></ul></li><li>two</li></ol>",
    );
  });
  it("joins indented continuation lines", () => {
    expect(renderMarkdown("- a\n  more")).toBe("<ul><li>a more</li></ul>");
  });
  it("renders task items", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] **done**")).toBe(
      '<ul><li class="task"><span class="check" aria-hidden="true">☐</span> todo</li>' +
        '<li class="task done"><span class="check done" aria-hidden="true">☑</span> <strong>done</strong></li></ul>',
    );
  });
});

describe("code fences", () => {
  it("keeps the language", () => {
    expect(renderMarkdown("```sh\nls -la\n```")).toBe('<pre><code data-lang="sh">ls -la</code></pre>');
    expect(renderMarkdown("```c++ title\nx\n```")).toBe('<pre><code data-lang="c++">x</code></pre>');
  });
  it("drops unsafe languages", () => {
    expect(renderMarkdown('```"><img onerror=alert(1)>\nx\n```')).toBe("<pre><code>x</code></pre>");
    expect(renderMarkdown("```a<b\nx\n```")).toBe("<pre><code>x</code></pre>");
  });
  it("treats an unterminated fence as code to the end", () => {
    expect(renderMarkdown("hi\n```js\n**a**\n- b")).toBe(
      '<p>hi</p><pre><code data-lang="js">**a**\n- b</code></pre>',
    );
  });
});

describe("tables", () => {
  it("renders a pipe table with alignment", () => {
    const html = renderMarkdown(
      "| Name | Qty | Price |\n|:---|:--:|---:|\n| **Tea** | 2 | $3 |\n| Cake | 1 |",
    );
    expect(html).toBe(
      '<div class="table-wrap"><table><thead><tr><th>Name</th><th class="al-c">Qty</th><th class="al-r">Price</th></tr></thead>' +
        '<tbody><tr><td><strong>Tea</strong></td><td class="al-c">2</td><td class="al-r">$3</td></tr>' +
        '<tr><td>Cake</td><td class="al-c">1</td><td class="al-r"></td></tr></tbody></table></div>',
    );
  });
  it("allows missing outer pipes and escaped pipes", () => {
    expect(renderMarkdown("a | b\n--- | ---\n`x\\|y` | 1\\|2\n\nafter")).toBe(
      '<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead>' +
        "<tbody><tr><td><code>x|y</code></td><td>1|2</td></tr></tbody></table></div><p>after</p>",
    );
  });
  it("needs a matching separator row", () => {
    expect(renderMarkdown("a | b\n---")).toBe("<p>a | b</p><hr>");
    expect(renderMarkdown("a | b\nc | d")).toBe("<p>a | b<br>c | d</p>");
  });
  it("escapes cells", () => {
    const html = renderMarkdown('| h |\n|---|\n| "><img src=x onerror=alert(1)> |');
    expect(html).not.toContain("<img");
    expect(html).toContain("<td>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</td>");
  });
});

describe("images", () => {
  it("links web pictures and labels local ones by default", () => {
    expect(renderMarkdown("See ![a cat](https://x.y/cat.png) here")).toBe(
      '<p>See <a href="https://x.y/cat.png" class="img-link" target="_blank" rel="noopener noreferrer">🖼 a cat</a> here</p>',
    );
    expect(renderMarkdown("![](/home/yo/shot.png)")).toBe(
      '<p><span class="img-missing">Picture: shot.png</span></p>',
    );
    expect(renderMarkdown("![screen](file:///tmp/a.png)")).toBe(
      '<p><span class="img-missing">Picture: screen</span></p>',
    );
    expect(renderMarkdown("![](https://x.y/a.png)")).toContain(">🖼 Picture</a>");
  });
  it("supports titles and <src with spaces>", () => {
    const seen = [];
    renderMarkdown('![a](<my shot.png> "t") ![b](b.png "Title")', {
      image: (src, alt) => {
        seen.push([src, alt]);
        return null;
      },
    });
    expect(seen).toEqual([
      ["my shot.png", "a"],
      ["b.png", "b"],
    ]);
  });
  it("inserts the caller's html, as its own block when the picture is alone", () => {
    const image = (src, alt) => `<figure data-src="${src}">${alt}</figure>`;
    expect(renderMarkdown("Look:\n![one](1.png)\nnice", { image })).toBe(
      '<p>Look:</p><figure data-src="1.png">one</figure><p>nice</p>',
    );
    expect(renderMarkdown("x ![two](2.png) y", { image })).toBe(
      '<p>x <figure data-src="2.png">two</figure> y</p>',
    );
  });
  it("falls back when the callback returns null or throws", () => {
    expect(renderMarkdown("![p](/a/p.png)", { image: () => null })).toBe(
      '<p><span class="img-missing">Picture: p</span></p>',
    );
    expect(
      renderMarkdown("![p](/a/p.png)", {
        image: () => {
          throw new Error("x");
        },
      }),
    ).toBe('<p><span class="img-missing">Picture: p</span></p>');
  });
  it("calls the callback once per picture", () => {
    let calls = 0;
    renderMarkdown("![a](a.png)\n\ntext ![b](b.png)", {
      image: () => {
        calls++;
        return null;
      },
    });
    expect(calls).toBe(2);
  });
  it("escapes alt and src", () => {
    const html = renderMarkdown('![x" onerror="alert(1)](https://a.b/"onload="x)  ![<b>](/p/"><img>.png)');
    expect(html).not.toMatch(/<img|<b>| onerror="| onload="/);
    expect(html).toContain('href="https://a.b/&quot;onload=&quot;x"');
  });
  it("does not render pictures inside code", () => {
    const html = renderMarkdown("`![a](https://x.y/a.png)`\n```\n![b](b.png)\n```", {
      image: () => "<figure></figure>",
    });
    expect(html).not.toContain("<figure>");
  });
});

describe("safety", () => {
  it("never makes attributes from input", () => {
    const html = renderMarkdown(
      [
        '[x](https://a.b/" onclick="alert(1))',
        '<https://a.b/"><script>alert(1)</script>>',
        'https://a.b/"onmouseover="alert(1)',
        "[y](javascript:alert('x'))",
        "- [x] <script>alert(1)</script>",
        "> <img src=x onerror=alert(1)>",
        "# <script>",
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script|<img| onclick="| onmouseover="|href="javascript/i);
  });
});

describe("imageSources", () => {
  it("lists pictures in order, once each, skipping code", () => {
    const text = [
      "![one](/a/1.png) and ![dup](/a/1.png)",
      "`![code](/a/x.png)`",
      "```",
      "![fenced](/a/y.png)",
      "```",
      "> ![two](<my pic.png>)",
      "| ![three](https://x.y/3.png) |",
    ].join("\n");
    expect(imageSources(text)).toEqual([
      { src: "/a/1.png", alt: "one" },
      { src: "my pic.png", alt: "two" },
      { src: "https://x.y/3.png", alt: "three" },
    ]);
    expect(imageSources("")).toEqual([]);
  });
});

describe("toSpeech", () => {
  it("strips markup", () => {
    expect(toSpeech("**Done.** See [the doc](https://x.y) and https://a.b/c\n- one")).toBe(
      "Done. See the doc and a link one",
    );
  });
  it("reads tables, pictures, quotes, rules and tasks plainly", () => {
    expect(
      toSpeech(
        "| Name | Qty |\n|---|:-:|\n| Tea | 2 |\n\n---\n\n> Quote\n\n![a cat](cat.png) ![](x.png)\n- [x] done\n<https://a.b>",
      ),
    ).toBe("Name, Qty. Tea, 2. Quote a cat a picture done a link");
  });
});
