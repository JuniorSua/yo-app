import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

function fakeDocument(copyWorks: boolean) {
  const made: { value: string; removed: boolean }[] = [];
  const doc = {
    activeElement: null,
    body: { appendChild: vi.fn() },
    createElement: () => {
      const ta = {
        value: "",
        removed: false,
        style: {},
        setAttribute: () => {},
        select: () => {},
        remove() {
          ta.removed = true;
        },
      };
      made.push(ta);
      return ta;
    },
    execCommand: vi.fn(() => copyWorks),
  };
  return { doc: doc as unknown as Document, made, execCommand: doc.execCommand };
}

describe("copyText", () => {
  it("uses the async clipboard when there is one", async () => {
    const writeText = vi.fn(async () => {});
    const { doc, execCommand } = fakeDocument(true);
    expect(await copyText("hello **world**", { clipboard: { writeText }, document: doc })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello **world**");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a hidden textarea when the clipboard is missing", async () => {
    const { doc, made, execCommand } = fakeDocument(true);
    expect(await copyText("brew install yo", { document: doc })).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(made[0]).toMatchObject({ value: "brew install yo", removed: true });
  });

  it("falls back when the clipboard refuses", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    const { doc, execCommand } = fakeDocument(true);
    expect(await copyText("x", { clipboard: { writeText }, document: doc })).toBe(true);
    expect(execCommand).toHaveBeenCalled();
  });

  it("reports failure when nothing works", async () => {
    const { doc } = fakeDocument(false);
    expect(await copyText("x", { document: doc })).toBe(false);
    expect(await copyText("x", {})).toBe(false);
  });
});
