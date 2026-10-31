// The apple-app-site-association file: a phone link opens the Yo iPhone app when it's installed (universal link),
// and everything else on yo-phone.vercel.app stays on the web.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const AASA_PATH = "/.well-known/apple-app-site-association";
const aasa = JSON.parse(read(".well-known/apple-app-site-association"));
const vercel = JSON.parse(read("vercel.json"));

const APP_ID = "D5MC3NH58Y.dev.yo.phone"; // Team ID + bundle ID of the Yo iPhone app
const b64 = (c) => c.repeat(43);
const LINK = `https://yo-phone.vercel.app/#k=${b64("A")}&a=${b64("b")}&p=${b64("C")}`;

/** Apple's component patterns: `*` is any run of characters (even none), `?` is one character. */
function wildcard(pattern, value) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(value);
}

/** Whether iOS hands `url` to the app: the first component whose path, fragment and query all match wins. */
function opensApp(url) {
  const u = new URL(url);
  const fragment = u.hash ? u.hash.slice(1) : null;
  for (const detail of aasa.applinks.details)
    for (const c of detail.components) {
      if (c["/"] !== undefined && !wildcard(c["/"], u.pathname)) continue;
      if (c["#"] !== undefined && (fragment === null || !wildcard(c["#"], fragment))) continue;
      if (c["?"] !== undefined && !wildcard(c["?"], u.search.slice(1))) continue;
      return !c.exclude;
    }
  return false;
}

/** vercel.json `source` patterns, enough for the ones in this file: literal paths and `(.*)`. */
function sourceMatches(source, path) {
  const re = source
    .split("(.*)")
    .map((part) => part.replace(/[.+?^${}()|[\]\\*]/g, "\\$&"))
    .join("(.*)");
  return new RegExp(`^${re}$`).test(path);
}

describe("apple-app-site-association", () => {
  it("uses the modern applinks format for the Yo app only", () => {
    expect(Object.keys(aasa)).toEqual(["applinks"]);
    expect(aasa.applinks.details).toHaveLength(1);
    const [detail] = aasa.applinks.details;
    expect(detail.appIDs).toEqual([APP_ID]);
    expect(detail).not.toHaveProperty("paths"); // the pre-iOS 13 format
    expect(detail.components).toEqual([
      expect.objectContaining({ "/": "/", "#": "*k=*", comment: expect.any(String) }),
    ]);
  });

  it("opens the app for a phone link", () => {
    expect(opensApp(LINK)).toBe(true);
    expect(opensApp(`https://yo-phone.vercel.app/#a=${b64("b")}&k=${b64("A")}`)).toBe(true);
  });

  it("keeps everything else on the web", () => {
    for (const url of [
      "https://yo-phone.vercel.app/",
      "https://yo-phone.vercel.app/#",
      "https://yo-phone.vercel.app/#drive",
      `https://yo-phone.vercel.app/index.html#k=${b64("A")}`,
      `https://yo-phone.vercel.app/app.js#k=${b64("A")}`,
      "https://yo-phone.vercel.app/api/relay/poll",
      "https://yo-phone.vercel.app/manifest.webmanifest",
      "https://yo-phone.vercel.app/.well-known/apple-app-site-association",
    ])
      expect(opensApp(url), url).toBe(false);
  });

  it("is served as JSON, with no extension, and nothing rewrites, redirects or ignores it", () => {
    const types = vercel.headers
      .filter((rule) => sourceMatches(rule.source, AASA_PATH))
      .flatMap((rule) => rule.headers)
      .filter((h) => h.key.toLowerCase() === "content-type")
      .map((h) => h.value);
    expect(types).toEqual(["application/json"]);
    for (const rule of [...(vercel.rewrites ?? []), ...(vercel.redirects ?? [])])
      expect(sourceMatches(rule.source, AASA_PATH), rule.source).toBe(false);
    expect(vercel.cleanUrls).toBeFalsy();
    expect(vercel.trailingSlash).toBe(false); // no trailing slash on the path, so no redirect either

    const ignored = read(".vercelignore")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const pattern of ignored)
      for (const part of [".well-known", "apple-app-site-association", AASA_PATH.slice(1)])
        expect(wildcard(pattern.replace(/^\//, ""), part), `${pattern} vs ${part}`).toBe(false);
  });
});
