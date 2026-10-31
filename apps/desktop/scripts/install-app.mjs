// Copies the built app into /Applications and clears quarantine.
// A YO_BUNDLE_ID_SUFFIX build installs that product only (Yo Test.app) and quits that product only.
// It does not quit or replace /Applications/Yo.app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installPaths, quitAppleScript } from "./bundle-identity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function invokedDirectly(metaUrl = import.meta.url, argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(path.resolve(entry)).href;
}

function main() {
  const { identity, built, target } = installPaths({
    desktopDir: path.join(here, ".."),
    installDir: process.env.YO_INSTALL_DIR,
  });
  if (identity.suffix && path.basename(target) === "Yo.app") {
    console.error("Refusing to replace Yo.app from a test build.");
    process.exit(1);
  }
  if (!fs.existsSync(built)) {
    console.error(`Not found: ${built}`);
    process.exit(1);
  }
  try {
    execFileSync("osascript", ["-e", quitAppleScript(identity.productName)], { stdio: "ignore" });
  } catch {}
  fs.rmSync(target, { recursive: true, force: true });
  execFileSync("ditto", [built, target]);
  // Keep the signature from `package` (sign-app.mjs); only fall back to ad-hoc for an unsigned build.
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", target], { stdio: "ignore" });
  } catch {
    // Same signer as `package`. A one-shot `codesign --deep` would drop limactl's virtualization entitlement.
    execFileSync(process.execPath, [path.join(here, "sign-app.mjs"), target], { stdio: "inherit" });
  }
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", target]);
  } catch {}
  console.log(`Installed ${target}`);
}

if (invokedDirectly()) main();
