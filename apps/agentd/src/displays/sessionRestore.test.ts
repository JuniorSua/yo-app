import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSessionRestore } from "./sessionRestore";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prepareSessionRestore", () => {
  it("starts blank on a fresh profile", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "yo-prof-"));
    expect(prepareSessionRestore(dir)).toBe(false);
  });

  it("switches an existing profile to continue-where-you-left-off and keeps other prefs", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "yo-prof-"));
    mkdirSync(path.join(dir, "Default", "Sessions"), { recursive: true });
    writeFileSync(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({
        session: { restore_on_startup: 5 },
        profile: { exit_type: "Crashed", name: "x" },
        keep: 1,
      }),
    );
    writeFileSync(path.join(dir, "Default", "Sessions", "Session_13370000000000000"), "data");
    expect(prepareSessionRestore(dir)).toBe(true);
    const prefs = JSON.parse(readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
    expect(prefs.session.restore_on_startup).toBe(1);
    expect(prefs.profile).toEqual({ exit_type: "Normal", exited_cleanly: true, name: "x" });
    expect(prefs.keep).toBe(1);
  });

  it("leaves a corrupt Preferences file alone", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "yo-prof-"));
    mkdirSync(path.join(dir, "Default"), { recursive: true });
    writeFileSync(path.join(dir, "Default", "Preferences"), "{not json");
    expect(prepareSessionRestore(dir)).toBe(false);
    expect(readFileSync(path.join(dir, "Default", "Preferences"), "utf8")).toBe("{not json");
  });
});

describe("pending browser carry-over", () => {
  it("lists saved tabs that didn't come back, keeping duplicates", async () => {
    const { missingTabs } = await import("./sessionRestore");
    expect(missingTabs(["a", "b", "b", "c"], ["b", "a", "x"])).toEqual(["b", "c"]);
  });

  it("turns CDP cookies into setCookies params, keeping session cookies session-only", async () => {
    const { toCookieParam } = await import("./sessionRestore");
    expect(
      toCookieParam({
        name: "s",
        value: "v",
        domain: ".x.com",
        path: "/",
        session: true,
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      }),
    ).toEqual({
      name: "s",
      value: "v",
      domain: ".x.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(
      toCookieParam({ name: "p", value: "v", domain: "x.com", expires: 2e9, session: false }),
    ).toMatchObject({ expires: 2e9 });
    expect(toCookieParam({ value: "v" })).toBeNull();
  });

  it("reads only http(s) tabs from the carry-over file", async () => {
    const { readPendingRestore, RESTORE_FILE } = await import("./sessionRestore");
    dir = mkdtempSync(path.join(os.tmpdir(), "yo-prof-"));
    writeFileSync(
      path.join(dir, RESTORE_FILE),
      JSON.stringify({ cookies: [{ name: "a" }, 3], tabs: ["https://a", "chrome://settings", 5] }),
    );
    expect(readPendingRestore(dir)).toEqual({ cookies: [{ name: "a" }], tabs: ["https://a"] });
  });
});
