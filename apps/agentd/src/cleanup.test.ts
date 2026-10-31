import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneOldFiles, STAGED_DOWNLOAD_MAX_AGE_MS } from "./cleanup";

describe("pruneOldFiles", () => {
  it("removes old staged downloads and keeps recent ones and folders", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yo-prune-"));
    const now = Date.now();
    const old = path.join(dir, "old-guid");
    const fresh = path.join(dir, "fresh-guid");
    writeFileSync(old, "x");
    writeFileSync(fresh, "y");
    const twoDaysAgo = (now - 2 * STAGED_DOWNLOAD_MAX_AGE_MS) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    mkdirSync(path.join(dir, "sub"));
    utimesSync(path.join(dir, "sub"), twoDaysAgo, twoDaysAgo);

    expect(await pruneOldFiles(dir, STAGED_DOWNLOAD_MAX_AGE_MS, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path.join(dir, "sub"))).toBe(true);
  });

  it("is fine with a missing folder", async () => {
    expect(await pruneOldFiles("/nonexistent/yo-downloads", 1000)).toBe(0);
  });
});
