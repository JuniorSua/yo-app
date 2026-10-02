import { describe, expect, it } from "vitest";
import {
  compareVersions,
  distNames,
  latestMacYml,
  zipName,
  zipsToPrune,
  zipVersion,
} from "../scripts/feed.mjs";

describe("update feed", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("0.1.312", "0.1.313")).toBe(-1);
    expect(compareVersions("0.1.1000", "0.1.999")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.999")).toBe(1);
    expect(compareVersions("0.1.0", "0.1")).toBe(0);
  });

  it("names zips like electron-builder, with the arch electron-updater looks for", () => {
    expect(zipName("Yo", "0.1.313")).toBe("Yo-0.1.313-arm64-mac.zip");
    expect(zipName("Yo Update Test", "0.1.5")).toBe("Yo-Update-Test-0.1.5-arm64-mac.zip");
    expect(zipVersion("Yo-0.1.313-arm64-mac.zip")).toBe("0.1.313");
    expect(zipVersion("latest-mac.yml")).toBeNull();
  });

  it("names the GitHub Release files apart from the feed's", () => {
    expect(distNames("Yo", "0.1.313")).toEqual({ dmg: "Yo-0.1.313-arm64.dmg", zip: "Yo-0.1.313-arm64.zip" });
    // Not a feed zip: publish-app's pruning never mistakes one for the other.
    expect(zipVersion(distNames("Yo", "0.1.313").zip)).toBeNull();
  });

  it("keeps only the newest two zips", () => {
    const names = [
      "latest-mac.yml",
      "Yo-0.1.99-arm64-mac.zip",
      "Yo-0.1.312-arm64-mac.zip",
      "Yo-0.1.1000-arm64-mac.zip",
      "Yo-0.1.313-arm64-mac.zip",
    ];
    expect(zipsToPrune(names).sort()).toEqual(["Yo-0.1.312-arm64-mac.zip", "Yo-0.1.99-arm64-mac.zip"]);
    expect(zipsToPrune(["Yo-0.1.1-arm64-mac.zip"])).toEqual([]);
  });

  it("writes latest-mac.yml the way electron-updater reads it", () => {
    const yml = latestMacYml({
      version: "0.1.313",
      file: "Yo-0.1.313-arm64-mac.zip",
      sha512: "q83vEjRWeJAJ+M2l0OixSmKzKqt8n5Z1Kj9VhTSbAuWfV2Jr0rIhaAOEF/BX52x0Qs2i+3R6j6mFmEe4F6z7DQ==",
      size: 123456,
      releaseDate: "2026-10-01T12:00:00.000Z",
    });
    expect(yml).toBe(
      [
        "version: 0.1.313",
        "files:",
        "  - url: Yo-0.1.313-arm64-mac.zip",
        "    sha512: q83vEjRWeJAJ+M2l0OixSmKzKqt8n5Z1Kj9VhTSbAuWfV2Jr0rIhaAOEF/BX52x0Qs2i+3R6j6mFmEe4F6z7DQ==",
        "    size: 123456",
        "path: Yo-0.1.313-arm64-mac.zip",
        "sha512: q83vEjRWeJAJ+M2l0OixSmKzKqt8n5Z1Kj9VhTSbAuWfV2Jr0rIhaAOEF/BX52x0Qs2i+3R6j6mFmEe4F6z7DQ==",
        "releaseDate: '2026-10-01T12:00:00.000Z'",
        "",
      ].join("\n"),
    );
    expect(() =>
      latestMacYml({ version: "1\nx: y", file: "a.zip", sha512: "x", size: 1, releaseDate: "" }),
    ).toThrow();
    expect(() =>
      latestMacYml({ version: "1", file: "a.zip", sha512: "x", size: 0, releaseDate: "" }),
    ).toThrow();
  });
});
