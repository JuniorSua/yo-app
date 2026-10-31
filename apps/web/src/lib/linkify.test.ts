import { describe, expect, it } from "vitest";
import { linkify } from "./linkify";

describe("linkify", () => {
  it("finds links in a message and leaves the rest as text", () => {
    expect(linkify("see https://polestar.com/us/a?b=1&c=2 for the quote")).toEqual([
      { text: "see " },
      { text: "https://polestar.com/us/a?b=1&c=2", href: "https://polestar.com/us/a?b=1&c=2" },
      { text: " for the quote" },
    ]);
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(linkify("Open https://x.com/a.")).toEqual([
      { text: "Open " },
      { text: "https://x.com/a", href: "https://x.com/a" },
      { text: "." },
    ]);
    expect(linkify("(https://x.com/Foo_(bar))")[1]).toEqual({
      text: "https://x.com/Foo_(bar)",
      href: "https://x.com/Foo_(bar)",
    });
  });

  it("plain text and non-web schemes stay text", () => {
    expect(linkify("no links here")).toEqual([{ text: "no links here" }]);
    expect(linkify("javascript:alert(1)")).toEqual([{ text: "javascript:alert(1)" }]);
  });
});
