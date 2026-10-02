// Turns the packaged, signed Yo.app into the files a GitHub Release offers:
//   release/dist/Yo-<version>-arm64.dmg   drag-to-Applications disk image
//   release/dist/Yo-<version>-arm64.zip   the same app, zipped
// Both are made from the *signed* app (sign-app.mjs runs before this), with macOS's own tools, so the
// signature inside is exactly the one sign-app.mjs made. Runs on macOS only.
//
//   node apps/desktop/scripts/make-dist.mjs [--app <path/Yo.app>] [--out <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distNames } from "./feed.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const app = path.resolve(opt("--app") ?? path.join(desktop, "release", "mac-arm64", "Yo.app"));
const out = path.resolve(opt("--out") ?? path.join(desktop, "release", "dist"));

if (!fs.existsSync(path.join(app, "Contents", "Info.plist"))) {
  console.error(`Not a built app: ${app}`);
  process.exit(1);
}
const plist = (key) =>
  execFileSync("plutil", ["-extract", key, "raw", "-o", "-", path.join(app, "Contents", "Info.plist")], {
    encoding: "utf8",
  }).trim();
const version = plist("CFBundleShortVersionString");
const product = plist("CFBundleName");
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });

const names = distNames(product, version);
fs.mkdirSync(out, { recursive: true });
const zip = path.join(out, names.zip);
const dmg = path.join(out, names.dmg);
fs.rmSync(zip, { force: true });
fs.rmSync(dmg, { force: true });

execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip], { stdio: "inherit" });

// The disk image holds Yo.app and a link to /Applications to drag it onto.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "yo-dmg-"));
try {
  execFileSync("ditto", [app, path.join(stage, path.basename(app))], { stdio: "inherit" });
  fs.symlinkSync("/Applications", path.join(stage, "Applications"));
  execFileSync(
    "hdiutil",
    ["create", "-volname", product, "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-ov", dmg],
    { stdio: "inherit" },
  );
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

for (const f of [dmg, zip]) console.log(`${f} (${(fs.statSync(f).size / 1e6).toFixed(1)} MB)`);
