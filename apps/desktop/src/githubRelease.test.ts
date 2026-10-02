import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotVersion } from "../../../scripts/build-info.mjs";
import { DEFAULT_UPDATE_REPO, resolveUpdateChannel } from "../scripts/channel.mjs";
import { isReleasePageUrl, latestReleaseApiUrl, readLatestRelease, releaseVersion } from "./githubRelease";

const REPO = "JuniorSua/yo-app";
const page = (tag: string) => `https://github.com/${REPO}/releases/tag/${tag}`;
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: page(tag),
  draft: false,
  prerelease: false,
  ...extra,
});

describe("GitHub Releases check", () => {
  it("asks the public repo's latest release", () => {
    expect(latestReleaseApiUrl(REPO)).toBe("https://api.github.com/repos/JuniorSua/yo-app/releases/latest");
  });

  it("reads v0.1.N tags", () => {
    expect(releaseVersion("v0.1.313")).toBe("0.1.313");
    expect(releaseVersion("0.1.313")).toBe("0.1.313");
    expect(releaseVersion("v0.1.313-beta")).toBeNull();
    expect(releaseVersion("latest")).toBeNull();
    expect(releaseVersion(313)).toBeNull();
  });

  it("offers only a newer release, numerically", () => {
    expect(readLatestRelease(200, release("v0.1.1000"), "0.1.999", REPO)).toEqual({
      kind: "newer",
      version: "0.1.1000",
      url: page("v0.1.1000"),
    });
    expect(readLatestRelease(200, release("v0.1.312"), "0.1.312", REPO)).toEqual({ kind: "none" });
    expect(readLatestRelease(200, release("v0.1.300"), "0.1.312", REPO)).toEqual({ kind: "none" });
    // Not string order: 0.1.10 > 0.1.9, and a minor/major bump beats any patch number.
    expect(readLatestRelease(200, release("v0.1.10"), "0.1.9", REPO).kind).toBe("newer");
    expect(readLatestRelease(200, release("v0.2.0"), "0.1.999", REPO).kind).toBe("newer");
    expect(readLatestRelease(200, release("v1.0.0"), "0.9.9", REPO).kind).toBe("newer");
    expect(readLatestRelease(200, release("v0.1.9"), "0.1.10", REPO).kind).toBe("none");
  });

  it("never throws on a malformed answer", () => {
    for (const body of [null, undefined, "", 42, [], { tag_name: null }, { tag_name: "v0.1.999" }])
      expect(readLatestRelease(200, body, "0.1.312", REPO).kind).toBe("quiet");
  });

  it("treats no release yet, drafts and pre-releases as nothing new", () => {
    expect(readLatestRelease(404, { message: "Not Found" }, "0.1.312", REPO)).toEqual({ kind: "none" });
    expect(readLatestRelease(200, release("v0.1.400", { draft: true }), "0.1.312", REPO).kind).toBe("none");
    expect(readLatestRelease(200, release("v0.1.400", { prerelease: true }), "0.1.312", REPO).kind).toBe(
      "none",
    );
  });

  it("stays quiet when offline, rate limited or the answer is odd", () => {
    for (const status of [0, 403, 429, 500, 502])
      expect(readLatestRelease(status, null, "0.1.312", REPO).kind).toBe("quiet");
    expect(readLatestRelease(200, null, "0.1.312", REPO).kind).toBe("quiet");
    expect(readLatestRelease(200, release("nightly"), "0.1.312", REPO).kind).toBe("quiet");
    // A newer tag whose page isn't this repo's release page is never offered.
    expect(
      readLatestRelease(200, release("v0.1.400", { html_url: "https://evil.example/x" }), "0.1.312", REPO)
        .kind,
    ).toBe("quiet");
  });

  it("opens only https://github.com/<repo>/releases/… pages", () => {
    expect(isReleasePageUrl(page("v0.1.313"), REPO)).toBe(true);
    expect(isReleasePageUrl(`https://github.com/${REPO}/releases/latest`, REPO)).toBe(true);
    for (const bad of [
      `http://github.com/${REPO}/releases/tag/v1`,
      `https://github.com.evil.example/${REPO}/releases/tag/v1`,
      `https://github.com/someone/else/releases/tag/v1`,
      `https://github.com/${REPO}/issues/1`,
      `https://github.com/${REPO}/releases`,
      `https://user@github.com/${REPO}/releases/tag/v1`,
      `https://github.com:8443/${REPO}/releases/tag/v1`,
      `file:///Applications/Yo.app`,
      "not a url",
      null,
    ])
      expect(isReleasePageUrl(bad, REPO)).toBe(false);
  });
});

describe("public snapshot version", () => {
  const dir = (version?: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "yo-version-"));
    if (version !== undefined) fs.writeFileSync(path.join(d, "VERSION"), version);
    return d;
  };

  it("reads the VERSION file the public repo carries instead of its commit count", () => {
    expect(snapshotVersion(dir("0.1.313\n"))).toBe("0.1.313");
    expect(snapshotVersion(dir())).toBeNull(); // this repo: the commit count stays the version
  });

  it("refuses a malformed VERSION", () => {
    expect(() => snapshotVersion(dir("v0.1.313"))).toThrow(/VERSION/);
    expect(() => snapshotVersion(dir(""))).toThrow(/VERSION/);
  });
});

describe("update channel (build time)", () => {
  it("keeps the owner's builds from this repo on the feed unless told otherwise", () => {
    expect(resolveUpdateChannel({}, { publicSnapshot: false })).toEqual({
      channel: "feed",
      repo: DEFAULT_UPDATE_REPO,
      computerImageRepo: null,
    });
    expect(resolveUpdateChannel({ YO_UPDATE_CHANNEL: "feed" }, { publicSnapshot: true }).channel).toBe(
      "feed",
    );
  });

  it("makes public builds follow GitHub Releases and pull the published computer image", () => {
    expect(resolveUpdateChannel({}, { publicSnapshot: true })).toEqual({
      channel: "github",
      repo: "JuniorSua/yo-app",
      computerImageRepo: "ghcr.io/juniorsua/yo-computer",
    });
    expect(
      resolveUpdateChannel(
        { YO_UPDATE_CHANNEL: "github", YO_UPDATE_REPO: "Some-One/yo-fork" },
        { publicSnapshot: false },
      ),
    ).toEqual({
      channel: "github",
      repo: "Some-One/yo-fork",
      computerImageRepo: "ghcr.io/some-one/yo-computer",
    });
  });

  it("lets the computer image be overridden or turned off (build it from source)", () => {
    const github = { YO_UPDATE_CHANNEL: "github" };
    expect(
      resolveUpdateChannel(
        { ...github, YO_COMPUTER_IMAGE_REPO: "registry.example:5000/me/computer" },
        {
          publicSnapshot: true,
        },
      ).computerImageRepo,
    ).toBe("registry.example:5000/me/computer");
    expect(
      resolveUpdateChannel({ ...github, YO_COMPUTER_IMAGE_REPO: "" }, { publicSnapshot: true })
        .computerImageRepo,
    ).toBeNull();
  });

  it("refuses typos instead of silently picking a channel", () => {
    expect(() => resolveUpdateChannel({ YO_UPDATE_CHANNEL: "gihub" }, { publicSnapshot: false })).toThrow();
    expect(() => resolveUpdateChannel({ YO_UPDATE_REPO: "no-slash" }, { publicSnapshot: false })).toThrow();
    expect(() =>
      resolveUpdateChannel({ YO_COMPUTER_IMAGE_REPO: "ghcr.io/x/y:latest" }, { publicSnapshot: false }),
    ).toThrow();
  });
});
