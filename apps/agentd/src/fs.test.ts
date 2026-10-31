import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const DATA = mkdtempSync(path.join(os.tmpdir(), "yo-agentd-fs-"));
process.env.YO_DATA_DIR = DATA;

const fsModule = await import("./fs");
const { listDir, PathError, resolveConfined, resolveConfinedReal } = fsModule;
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
      // ~/Shared: every agent's view of the shared folder.
      ["Shared", "dir"],
    ]);
  });
});

describe("copyHomeToShared (folding an agent into the main one)", () => {
  const old = path.join(DATA, "home", "agents", "old1");
  const shared = path.join(DATA, "home", "shared");
  const { copyHomeToShared, safeCopyDir } = fsModule;

  beforeAll(() => {
    mkdirSync(path.join(old, "reports", "2026"), { recursive: true });
    mkdirSync(path.join(old, "reports", "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(old, ".config", "chromium"), { recursive: true });
    mkdirSync(path.join(old, "notes", ".cache"), { recursive: true });
    writeFileSync(path.join(old, "todo.md"), "buy milk");
    writeFileSync(path.join(old, "screenshot.png"), "png");
    writeFileSync(path.join(old, "reports", "2026", "q1.csv"), "a,b");
    writeFileSync(path.join(old, "reports", "chart.png"), "keep: not top level");
    writeFileSync(path.join(old, "reports", "node_modules", "dep", "x.js"), "cache");
    writeFileSync(path.join(old, ".config", "chromium", "Login Data"), "secret");
    writeFileSync(path.join(old, "notes", ".cache", "c"), "cache");
    writeFileSync(path.join(old, "notes", "n.txt"), "note");
    symlinkSync(path.join(DATA, "home", "agents", "a2"), path.join(old, "link-to-a2"));
    symlinkSync(shared, path.join(old, "Shared"));
  });

  it("copies files into shared/from-<name>, leaving out screenshots, app state, caches and links", async () => {
    const r = await copyHomeToShared("old1", "from-Old");
    expect(r).toMatchObject({ dir: "from-Old", copied: 4, failed: 0 });
    const dest = path.join(shared, "from-Old");
    expect(readdirSync(dest).sort()).toEqual(["notes", "reports", "todo.md"]);
    expect(readFileSync(path.join(dest, "todo.md"), "utf8")).toBe("buy milk");
    expect(readFileSync(path.join(dest, "reports", "2026", "q1.csv"), "utf8")).toBe("a,b");
    // A .png below the top level is a real file; only top-level screenshots are dropped.
    expect(existsSync(path.join(dest, "reports", "chart.png"))).toBe(true);
    expect(existsSync(path.join(dest, "screenshot.png"))).toBe(false);
    expect(existsSync(path.join(dest, "reports", "node_modules"))).toBe(false);
    expect(existsSync(path.join(dest, "notes", ".cache"))).toBe(false);
    expect(existsSync(path.join(dest, ".config"))).toBe(false);
    expect(existsSync(path.join(dest, "link-to-a2"))).toBe(false);
    expect(existsSync(path.join(dest, "Shared"))).toBe(false);
  });

  it("is safe to repeat: nothing is copied twice, a changed file is refreshed", async () => {
    const again = await copyHomeToShared("old1", "from-Old");
    expect(again).toMatchObject({ copied: 0, failed: 0 });
    writeFileSync(path.join(old, "todo.md"), "buy milk and eggs");
    const third = await copyHomeToShared("old1", "from-Old");
    expect(third.copied).toBe(1);
    expect(readFileSync(path.join(shared, "from-Old", "todo.md"), "utf8")).toBe("buy milk and eggs");
  });

  it("an agent that never had a computer has nothing to copy", async () => {
    const r = await copyHomeToShared("never-had-one", "from-Ghost");
    expect(r).toEqual({ dir: "from-Ghost", copied: 0, skipped: 0, failed: 0, bytes: 0 });
  });

  it("keeps the destination inside the shared folder", async () => {
    expect(safeCopyDir("../../etc")).toBe("etc");
    expect(safeCopyDir(".hidden")).toBe("_hidden");
    expect(safeCopyDir("..")).toBe("_");
    expect(() => safeCopyDir("  ")).toThrow(PathError);
    await expect(copyHomeToShared("../a2", "from-x")).rejects.toThrow();
  });
});
