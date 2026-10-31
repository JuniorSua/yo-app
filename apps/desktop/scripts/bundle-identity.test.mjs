import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleIdentity,
  installPaths,
  macAppPath,
  quitAppleScript,
  userDataFolderName,
} from "./bundle-identity.mjs";
import { assertPackagedDeps, electronBuilderArgs } from "./package-app.mjs";

const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("YO_BUNDLE_ID_SUFFIX", () => {
  it("leaves the real app alone when the suffix is unset", () => {
    expect(bundleIdentity("")).toEqual({ appId: "dev.yo.app", productName: "Yo", suffix: "" });
    expect(bundleIdentity("   ")).toEqual({ appId: "dev.yo.app", productName: "Yo", suffix: "" });
    const installed = installPaths({ desktopDir: "/desktop" });
    expect(installed.built).toBe(path.join("/desktop", "release", "mac-arm64", "Yo.app"));
    expect(installed.target).toBe("/Applications/Yo.app");
    expect(quitAppleScript("Yo")).toBe('tell application "Yo" to quit');
    expect(userDataFolderName(bundleIdentity(""))).toBe("Yo");
  });

  it("gives a test build its own bundle id, product name and userData, and does not replace Yo.app", () => {
    const identity = bundleIdentity("test");
    expect(identity).toEqual({ appId: "dev.yo.app.test", productName: "Yo Test", suffix: "test" });
    expect(userDataFolderName(identity)).toBe("Yo Test");
    expect(macAppPath("/desktop", identity)).toBe(
      path.join("/desktop", "release", "mac-arm64", "Yo Test.app"),
    );
    const installed = installPaths({ desktopDir: "/desktop", identity, installDir: "/opt/yo-test" });
    expect(installed.built.endsWith(`${path.sep}Yo Test.app`)).toBe(true);
    expect(installed.target).toBe(path.join("/opt/yo-test", "Yo Test.app"));
    expect(path.basename(installed.target)).not.toBe("Yo.app");
    expect(installPaths({ desktopDir: "/desktop", identity }).target).toBe("/Applications/Yo Test.app");
    const quit = quitAppleScript(identity.productName);
    expect(quit).toBe('tell application "Yo Test" to quit');
    expect(quit).not.toBe('tell application "Yo" to quit');
    const built = electronBuilderArgs("0.1.9", [], { YO_BUNDLE_ID_SUFFIX: "test" });
    expect(built.identity.appId).toBe("dev.yo.app.test");
    expect(built.args).toContain("-c.appId=dev.yo.app.test");
    expect(built.args).toContain("-c.productName=Yo Test");
    expect(built.args).toContain("-c.extraMetadata.productName=Yo Test");
    expect(built.args.join(" ")).not.toContain("dev.yo.app ");
  });

  it("turns a hyphenated suffix into words, and rejects anything that is not a bundle-id fragment", () => {
    expect(bundleIdentity("qa-lab")).toEqual({
      appId: "dev.yo.app.qa-lab",
      productName: "Yo Qa Lab",
      suffix: "qa-lab",
    });
    for (const bad of ["Test", "dev.yo", "../yo", "a_b", "a b", "-test", "test-"]) {
      expect(() => bundleIdentity(bad)).toThrow(/YO_BUNDLE_ID_SUFFIX/);
    }
  });

  it("refuses to package when core or web has not been built", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yo-pkg-"));
    temps.push(root);
    const desktop = path.join(root, "desktop");
    expect(() => assertPackagedDeps(desktop)).toThrow(/Refusing to package/);
    fs.mkdirSync(path.join(root, "core", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "core", "dist", "core.mjs"), "");
    fs.mkdirSync(path.join(root, "web", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "web", "dist", "index.html"), "");
    expect(() => assertPackagedDeps(desktop)).not.toThrow();
  });
});
