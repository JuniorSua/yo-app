import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const DATA = mkdtempSync(path.join(os.tmpdir(), "yo-agentd-fs-"));
process.env.YO_DATA_DIR = DATA;

const { listDir, PathError, resolveConfined, resolveConfinedReal } = await import("./fs");
const home = path.join(DATA, "home", "agents", "a1");

describe("path confinement", () => {
  beforeAll(() => {
    mkdirSync(path.join(home, "docs"), { recursive: true });
    mkdirSync(path.join(DATA, "home", "shared"), { recursive: true });
    mkdirSync(path.join(DATA, "home", "agents", "a2"), { recursive: true });
    writeFileSync(path.join(home, "docs", "x.txt"), "hi");
    writeFileSync(path.join(DATA, "home", "agents", "a2", "secret.txt"), "nope");
    symlinkSync(path.join(DATA, "home", "agents", "a2"), path.join(home, "escape"));
  });

  it("resolves relative, ~ and absolute paths inside the home", () => {
    expect(resolveConfined("a1", "")).toBe(home);
    expect(resolveConfined("a1", "~")).toBe(home);
    expect(resolveConfined("a1", "docs")).toBe(path.join(home, "docs"));
    expect(resolveConfined("a1", "~/docs/x.txt")).toBe(path.join(home, "docs", "x.txt"));
    expect(resolveConfined("a1", path.join(home, "docs"))).toBe(path.join(home, "docs"));
    expect(resolveConfined("a1", path.join(DATA, "home", "shared"))).toBe(path.join(DATA, "home", "shared"));
  });

  it("rejects traversal and foreign absolute paths", () => {
    expect(() => resolveConfined("a1", "../a2/secret.txt")).toThrow(PathError);
    expect(() => resolveConfined("a1", "docs/../../a2")).toThrow(PathError);
    expect(() => resolveConfined("a1", "/etc/passwd")).toThrow(PathError);
    expect(() => resolveConfined("a1", `${home}-evil`)).toThrow(PathError);
    expect(() => resolveConfined("a1", "a\0b")).toThrow(PathError);
    expect(() => resolveConfined("../a2", "")).toThrow();
  });

  it("rejects symlink escapes after realpath", async () => {
    await expect(resolveConfinedReal("a1", "escape/secret.txt")).rejects.toThrow(PathError);
    await expect(resolveConfinedReal("a1", "docs/x.txt")).resolves.toBe(
      path.join(await import("node:fs").then((m) => m.realpathSync(home)), "docs", "x.txt"),
    );
  });

  it("lists directories dirs-first", async () => {
    const entries = await listDir("a1", "");
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ["docs", "dir"],
      ["escape", "dir"],
    ]);
  });
});
