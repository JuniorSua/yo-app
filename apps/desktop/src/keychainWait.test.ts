import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keychainHint, readKeychainState, rememberSignedInVersion } from "./keychainWait";

const base = {
  platform: "darwin",
  channel: "github" as const,
  version: "0.1.213",
  lastVersion: "0.1.212",
  hasSavedLogin: true,
};

describe("keychainHint", () => {
  it("explains right away on the first launch of a public build after an update", () => {
    expect(keychainHint(base)).toBe("now");
  });

  it("also explains when the saved login predates the version marker", () => {
    expect(keychainHint({ ...base, lastVersion: null })).toBe("now");
  });

  it("only offers the delayed hint when nothing changed since the last sign-in", () => {
    expect(keychainHint({ ...base, lastVersion: "0.1.213" })).toBe("later");
  });

  it("only offers the delayed hint on a fresh install (no Keychain item yet)", () => {
    expect(keychainHint({ ...base, lastVersion: null, hasSavedLogin: false })).toBe("later");
  });

  it("stays quiet for signed builds and other platforms", () => {
    expect(keychainHint({ ...base, channel: "feed" })).toBe("off");
    expect(keychainHint({ ...base, platform: "linux" })).toBe("off");
    expect(keychainHint({ ...base, platform: "win32" })).toBe("off");
  });
});

describe("readKeychainState / rememberSignedInVersion", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "yo-keychain-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reads an empty data folder as a fresh install", () => {
    expect(readKeychainState(tmp())).toEqual({ lastVersion: null, hasSavedLogin: false });
  });

  it("sees a saved login and the version that last signed in", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "controller.bin"), "x");
    rememberSignedInVersion(d, "0.1.212");
    expect(readKeychainState(d)).toEqual({ lastVersion: "0.1.212", hasSavedLogin: true });
  });

  it("never throws when the folder is missing", () => {
    const missing = path.join(tmp(), "nope");
    expect(() => rememberSignedInVersion(missing, "1")).not.toThrow();
    expect(readKeychainState(missing)).toEqual({ lastVersion: null, hasSavedLogin: false });
  });
});
