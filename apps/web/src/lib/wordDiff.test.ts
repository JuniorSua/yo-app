import { describe, expect, it } from "vitest";
import { type DiffPart, isRevision, wordDiff } from "./wordDiff";

const side = (parts: DiffPart[], op: "add" | "del") =>
  parts
    .filter((p) => p.op === "same" || p.op === op)
    .map((p) => p.text)
    .join("");

describe("wordDiff", () => {
  it("marks the changed word and keeps the rest", () => {
    expect(wordDiff("Hello there friend", "Hello dear friend")).toEqual([
      { text: "Hello ", op: "same" },
      { text: "there", op: "del" },
      { text: "dear", op: "add" },
      { text: " friend", op: "same" },
    ]);
  });

  it("joins neighbouring edits into one removal and one addition", () => {
    const parts = wordDiff("a b c", "x y c")!;
    expect(parts).toEqual([
      { text: "a b", op: "del" },
      { text: "x y", op: "add" },
      { text: " c", op: "same" },
    ]);
  });

  it("keeps words in place rather than matching spaces", () => {
    expect(wordDiff("one two three", "zero one three four")).toEqual([
      { text: "zero ", op: "add" },
      { text: "one ", op: "same" },
      { text: "two ", op: "del" },
      { text: "three", op: "same" },
      { text: " four", op: "add" },
    ]);
  });

  it("always rebuilds both versions exactly", () => {
    const cases: [string, string][] = [
      [
        "Hi Sam,\n\nSee you at 3pm on Friday.\n\nThanks",
        "Hi Sam,\n\nSee you at 4pm on Friday at the cafe.\n\nThanks!",
      ],
      ["one two three", "zero one three four"],
      ["", "brand new"],
      ["gone", ""],
      ["a  b", "a b"],
    ];
    for (const [a, b] of cases) {
      const parts = wordDiff(a, b)!;
      expect(side(parts, "del")).toBe(a);
      expect(side(parts, "add")).toBe(b);
    }
  });

  it("returns nothing for identical drafts' changes", () => {
    expect(wordDiff("same text", "same text")).toEqual([{ text: "same text", op: "same" }]);
  });

  it("gives up on very long drafts", () => {
    const long = "word ".repeat(2000);
    expect(wordDiff(long, `${long}more`)).toBeNull();
  });
});

describe("isRevision", () => {
  it("is a revision when most words are kept", () => {
    expect(isRevision(wordDiff("See you at 3pm on Friday", "See you at 4pm on Friday"))).toBe(true);
  });

  it("isn't when nothing changed", () => {
    expect(isRevision(wordDiff("Same", "Same"))).toBe(false);
  });

  it("isn't when it's a different message", () => {
    expect(isRevision(wordDiff("Lunch tomorrow?", "Your invoice for October is attached"))).toBe(false);
  });

  it("isn't when there's nothing to compare", () => {
    expect(isRevision(null)).toBe(false);
  });
});
