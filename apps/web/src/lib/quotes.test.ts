import { describe, expect, it } from "vitest";
import { quoteBlocks } from "./quotes";

describe("quoteBlocks", () => {
  it("leaves a message without quotes as one block", () => {
    expect(quoteBlocks("hi there\nsecond line")).toEqual([{ quote: false, text: "hi there\nsecond line" }]);
  });

  it("joins consecutive > lines into one quote and keeps the rest around it", () => {
    expect(quoteBlocks("About this:\n> Ship it Friday\n> and tell Sam\nOkay?")).toEqual([
      { quote: false, text: "About this:" },
      { quote: true, text: "Ship it Friday\nand tell Sam" },
      { quote: false, text: "Okay?" },
    ]);
  });

  it("takes > with or without a space, and up to three leading spaces", () => {
    expect(quoteBlocks(">tight\n   > indented")).toEqual([{ quote: true, text: "tight\nindented" }]);
  });

  it("doesn't treat a > inside a line as a quote", () => {
    expect(quoteBlocks("5 > 3, and a->b")).toEqual([{ quote: false, text: "5 > 3, and a->b" }]);
    expect(quoteBlocks("    > code-like")).toEqual([{ quote: false, text: "    > code-like" }]);
  });
});
