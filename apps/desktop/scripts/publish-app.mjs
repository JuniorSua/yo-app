// Publishes a packaged, signed Yo.app to the private update feed yo-core serves (see apps/desktop/src/updates.ts).
//
//   node apps/desktop/scripts/publish-app.mjs [--app <path/Yo.app>] [--out <dir>] [--local | --data-dir <dir>]
//
//   --app       the signed build (default: release/mac-arm64/Yo.app from `pnpm app:package`)
//   --out       folder to leave the zip + latest-mac.yml in (default: release/updates); release.py copies them to the PC
//   --local     also install them into this Mac's core data folder ($YO_DATA_DIR or ~/Library/Application Support/Yo)
//   --data-dir  same, into another core data folder (tests)
//
// The zip is made here from the *signed* app: electron-builder's own zip would hold the unsigned one, because
// sign-app.mjs runs after it. Squirrel.Mac only installs an update signed like the running app, so ad-hoc
// signed builds are refused. Installing writes the zip first and swaps latest-mac.yml in last, so a client
// never sees a feed that points at a missing file; only the newest two zips are kept.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latestMacYml, zipName, zipsToPrune } from "./feed.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const app = path.resolve(opt("--app") ?? path.join(desktop, "release", "mac-arm64", "Yo.app"));
const out = path.resolve(opt("--out") ?? path.join(desktop, "release", "updates"));
const dataDir = opt("--data-dir")
  ? path.resolve(opt("--data-dir"))
  : args.includes("--local")
    ? (process.env.YO_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "Yo"))
    : null;

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
// `codesign -dv` reports on stderr.
if (/Signature=adhoc/.test(spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr)) {
  console.error("This build is ad-hoc signed: installed apps would refuse it as an update. Sign it first.");
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const file = zipName(product, version);
const zip = path.join(out, file);
fs.rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
const bytes = fs.readFileSync(zip);
const yml = latestMacYml({
  version,
  file,
  sha512: crypto.createHash("sha512").update(bytes).digest("base64"),
  size: bytes.length,
  releaseDate: new Date().toISOString(),
});
fs.writeFileSync(path.join(out, "latest-mac.yml"), yml);
console.log(`Built feed for ${product} ${version}: ${zip} (${(bytes.length / 1e6).toFixed(1)} MB)`);

if (dataDir) {
  const feed = path.join(dataDir, "updates", "desktop");
  fs.mkdirSync(feed, { recursive: true, mode: 0o700 });
  fs.copyFileSync(zip, path.join(feed, `${file}.tmp`));
  fs.renameSync(path.join(feed, `${file}.tmp`), path.join(feed, file));
  fs.writeFileSync(path.join(feed, "latest-mac.yml.tmp"), yml);
  fs.renameSync(path.join(feed, "latest-mac.yml.tmp"), path.join(feed, "latest-mac.yml"));
  for (const old of zipsToPrune(fs.readdirSync(feed))) fs.rmSync(path.join(feed, old), { force: true });
  console.log(`Published ${version} to ${feed}`);
}
