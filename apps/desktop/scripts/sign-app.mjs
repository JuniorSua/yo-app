// Signs the packaged Yo.app (and the bundled native helper) in release/, or the app given as the argument.
//
// A stable signing identity matters: macOS ties privacy permissions (Files & Folders, later Contacts,
// Calendars…) to the app's signature, so an ad-hoc signature that changes every build would make
// macOS forget them. Identity: $YO_SIGN_IDENTITY, else the first "Apple Development" identity in the
// login keychain (free with an Apple ID), else ad-hoc as a last resort. Only the name is printed.
//
// Ad-hoc on purpose: YO_ADHOC_SIGN=1 (or YO_SIGN_IDENTITY=-). The public builds on GitHub Releases are made
// this way (.github/workflows/release.yml): there is no paid Developer ID, so users open them once with
// right-click → Open, and they update by downloading (the github update channel), not through Squirrel.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Optional argument: another built app to sign (e.g. a test build in a temp folder).
const app = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, "..", "release", "mac-arm64", "Yo.app");
if (!fs.existsSync(app)) {
  console.error(`Not found: ${app}`);
  process.exit(1);
}

function findIdentity() {
  if (process.env.YO_ADHOC_SIGN === "1") return "-";
  if (process.env.YO_SIGN_IDENTITY) return process.env.YO_SIGN_IDENTITY;
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const m = /"(Apple Development: [^"]+)"/.exec(out) ?? /"(Developer ID Application: [^"]+)"/.exec(out);
    if (m) return m[1];
  } catch {}
  return "-";
}

const identity = findIdentity();
const sign = (target, extra = []) =>
  execFileSync("codesign", ["--force", "--timestamp=none", "--sign", identity, ...extra, target], {
    stdio: "inherit",
  });

const helper = path.join(app, "Contents", "Resources", "YoDeviceBridge");
if (fs.existsSync(helper)) sign(helper, ["--identifier", "dev.yo.app.devicebridge"]);
// Nested frameworks/helpers first (--deep), then the app itself.
sign(app, ["--deep"]);
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
console.log(
  `Signed Yo.app with ${identity === "-" ? "an ad-hoc signature (permissions won't persist across builds)" : identity}`,
);
