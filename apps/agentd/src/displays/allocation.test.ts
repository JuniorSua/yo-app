import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allocateDisplay, cdpPort, DisplayAllocator, vncPort } from "./allocation";

describe("display allocation", () => {
  it("allocates the lowest free number and is stable", () => {
    const map: Record<string, number> = {};
    expect(allocateDisplay(map, "a1")).toEqual({ display: 1, changed: true });
    expect(allocateDisplay(map, "a2")).toEqual({ display: 2, changed: true });
    expect(allocateDisplay(map, "a1")).toEqual({ display: 1, changed: false });
    delete map.a1;
    expect(allocateDisplay(map, "a3").display).toBe(1);
  });

  it("throws when exhausted", () => {
    const map: Record<string, number> = { a: 1, b: 2 };
    expect(() => allocateDisplay(map, "c", 1, 2)).toThrow();
  });

  it("persists across instances", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "yo-disp-")), "displays.json");
    const a = new DisplayAllocator(file);
    expect(a.get("x")).toBe(1);
    expect(a.get("y")).toBe(2);
    const b = new DisplayAllocator(file);
    expect(b.get("y")).toBe(2);
    expect(b.get("z")).toBe(3);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("derives loopback ports from the display number", () => {
    expect(cdpPort(3)).toBe(9203);
    expect(vncPort(3)).toBe(5903);
  });
});
