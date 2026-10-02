// Packages Yo.app (release/mac-arm64/Yo.app, unsigned; sign-app.mjs signs it next) with the version stamped
// as 0.1.<commit count> (see scripts/build-info.mjs), so electron-updater sees every build from main as newer.
// YO_APP_VERSION (the release workflow passes the tag) or a public snapshot's VERSION file wins.
// Extra arguments go to electron-builder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appVersion } from "../../../scripts/build-info.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const version = appVersion(pkg.version);
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Not a version electron-updater and the GitHub check can compare: ${version}`);
  process.exit(1);
}
console.log(`Packaging Yo ${version}`);
execFileSync(
  "pnpm",
  [
    "exec",
    "electron-builder",
    "--mac",
    "dir",
    "--arm64",
    "--publish",
    "never",
    `-c.extraMetadata.version=${version}`,
    ...process.argv.slice(2),
  ],
  { cwd: desktop, stdio: "inherit" },
);
