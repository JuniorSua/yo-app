// A test build of Yo that can run beside the installed app.
//
// YO_BUNDLE_ID_SUFFIX=test (build time only) packages:
//   bundle id     dev.yo.app.test
//   product name  Yo Test
//   .app          release/mac-arm64/Yo Test.app
//   userData      ~/Library/Application Support/Yo Test
//
// Electron names the userData folder after the product name, so Quit stops the VM in that
// folder and never the one belonging to /Applications/Yo.app. The suffix is lowercase words
// separated by hyphens (`qa-lab` → product name "Yo Qa Lab", bundle id dev.yo.app.qa-lab).
import path from "node:path";

const BASE_APP_ID = "dev.yo.app";
const BASE_PRODUCT = "Yo";

export function bundleIdentity(suffix = process.env.YO_BUNDLE_ID_SUFFIX ?? "") {
  const raw = String(suffix).trim();
  if (!raw) return { appId: BASE_APP_ID, productName: BASE_PRODUCT, suffix: "" };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) {
    throw new Error(
      `YO_BUNDLE_ID_SUFFIX must be lowercase words separated by hyphens (got ${JSON.stringify(raw)}).`,
    );
  }
  const words = raw.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return { appId: `${BASE_APP_ID}.${raw}`, productName: `${BASE_PRODUCT} ${words.join(" ")}`, suffix: raw };
}

/** macOS userData is ~/Library/Application Support/<this name>. */
export function userDataFolderName(identity = bundleIdentity()) {
  return identity.productName;
}

export function macAppPath(desktopDir, identity = bundleIdentity()) {
  return path.join(desktopDir, "release", "mac-arm64", `${identity.productName}.app`);
}

export function installPaths(o) {
  const identity = o.identity ?? bundleIdentity();
  const appName = `${identity.productName}.app`;
  const installDir = o.installDir?.trim() ? o.installDir : "/Applications";
  return {
    identity,
    built: macAppPath(o.desktopDir, identity),
    target: path.join(installDir, appName),
  };
}

/** Quit only this product. A test build must not tell "Yo" to quit. */
export function quitAppleScript(productName) {
  const quoted = `"${String(productName).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `tell application ${quoted} to quit`;
}
