import { describe, expect, it } from "vitest";
import { codeKind, fenceLang, kindLabel } from "./codeKind";

describe("fenceLang", () => {
  it("reads the tag react-markdown puts on <code>", () => {
    expect(fenceLang("language-sh")).toBe("sh");
    expect(fenceLang("hljs language-TypeScript")).toBe("typescript");
    expect(fenceLang(undefined)).toBeUndefined();
    expect(fenceLang("")).toBeUndefined();
  });
});

describe("codeKind", () => {
  it("trusts the fence's tag", () => {
    expect(codeKind("sh", "Great, Michael! Want a test drive?")).toBe("code");
    expect(codeKind("text", "brew install yo")).toBe("text");
    expect(codeKind("email", "Hi Ana,\n\nThanks!")).toBe("text");
  });

  it("shows an untagged message or email as text", () => {
    expect(
      codeKind(
        undefined,
        "Great, Michael! You can see transparent pricing on the Polestar 4 here: https://www.polestar.com/us",
      ),
    ).toBe("text");
    expect(
      codeKind(undefined, "Subject: Saturday\n\nHi Ana,\n\nCan we move lunch to 1 PM?\n\nThanks,\nJ"),
    ).toBe("text");
  });

  it("keeps untagged commands, settings and code monospaced", () => {
    expect(codeKind(undefined, "brew install --cask yo && open -a Yo")).toBe("code");
    expect(codeKind(undefined, "$ npm run dev")).toBe("code");
    expect(codeKind(undefined, "YO_PORT=8787")).toBe("code");
    expect(codeKind(undefined, "name: yo\nport: 8787")).toBe("code");
    expect(codeKind(undefined, "const a = 1;\nconsole.log(a);")).toBe("code");
    expect(codeKind(undefined, "function hi() {\n  return 1\n}")).toBe("code");
    expect(codeKind(undefined, "https://yo-phone.vercel.app")).toBe("code");
    expect(codeKind(undefined, "")).toBe("code");
  });
});

describe("kindLabel", () => {
  it("names the block in plain words", () => {
    expect(kindLabel("text", undefined)).toBe("Text");
    expect(kindLabel("code", "bash")).toBe("Terminal");
    expect(kindLabel("code", "json")).toBe("JSON");
    expect(kindLabel("code", "rust")).toBe("rust");
    expect(kindLabel("code", undefined)).toBe("Code");
  });
});
