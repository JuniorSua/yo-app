// Packages the app (release/mac-arm64/<product>.app, unsigned; sign-app.mjs signs it next) with the version
// stamped as 2.0.<commit count> (see scripts/build-info.mjs), so electron-updater sees every build from main
// as newer. YO_APP_VERSION (the release workflow passes the tag) or a public snapshot's VERSION file wins.
// Extra arguments go to electron-builder.
//
// YO_BUNDLE_ID_SUFFIX=test builds Yo Test.app (bundle id dev.yo.app.test, userData "Yo Test") so a Mac
// can try Quit without replacing /Applications/Yo.app. Unset, this is the real Yo.app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appVersion } from "../../../scripts/build-info.mjs";
import { bundleIdentity } from "./bundle-identity.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** core.mjs and the web build. electron-builder skips a missing extraResources directory, so package checks these. */
export function packagedAppDeps(desktopDir) {
  return [
    path.join(desktopDir, "..", "core", "dist", "core.mjs"),
    path.join(desktopDir, "..", "web", "dist", "index.html"),
  ];
}

export function assertPackagedDeps(desktopDir) {
  const missing = packagedAppDeps(desktopDir).filter((file) => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(
      `Refusing to package: ${missing.join(", ")} is missing. pnpm --filter @yo/desktop package builds @yo/core and @yo/web first.`,
    );
  }
}

export function electronBuilderArgs(version, extra = [], env = process.env) {
  const identity = bundleIdentity(env.YO_BUNDLE_ID_SUFFIX ?? "");
  return {
    identity,
    args: [
      "exec",
      "electron-builder",
      "--mac",
      "dir",
      "--arm64",
      "--publish",
      "never",
      `-c.extraMetadata.version=${version}`,
      `-c.extraMetadata.productName=${identity.productName}`,
      `-c.productName=${identity.productName}`,
      `-c.appId=${identity.appId}`,
      ...extra,
    ],
  };
}

function invokedDirectly(metaUrl = import.meta.url, argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(path.resolve(entry)).href;
}

function main() {
  try {
    assertPackagedDeps(desktop);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
  const version = appVersion(pkg.version);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`Not a version electron-updater and the GitHub check can compare: ${version}`);
    process.exit(1);
  }
  const { identity, args } = electronBuilderArgs(version, process.argv.slice(2));
  console.log(`Packaging ${identity.productName} ${version} (${identity.appId})`);
  execFileSync("pnpm", args, { cwd: desktop, stdio: "inherit" });
}

if (invokedDirectly()) main();
