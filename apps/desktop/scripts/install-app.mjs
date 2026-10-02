// Copies the built Yo.app into /Applications, ad-hoc signs it (required on Apple silicon), and clears quarantine.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, "..", "release", "mac-arm64", "Yo.app");
const target = process.env.YO_INSTALL_DIR
  ? path.join(process.env.YO_INSTALL_DIR, "Yo.app")
  : "/Applications/Yo.app";

if (!fs.existsSync(built)) {
  console.error(`Not found: ${built}`);
  process.exit(1);
}
try {
  execFileSync("osascript", ["-e", 'tell application "Yo" to quit'], { stdio: "ignore" });
} catch {}
fs.rmSync(target, { recursive: true, force: true });
execFileSync("ditto", [built, target]);
// Keep the signature from `package` (sign-app.mjs); only fall back to ad-hoc for an unsigned build.
try {
  execFileSync("codesign", ["--verify", "--deep", "--strict", target], { stdio: "ignore" });
} catch {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", target], { stdio: "inherit" });
}
try {
  execFileSync("xattr", ["-dr", "com.apple.quarantine", target]);
} catch {}
console.log(`Installed ${target}`);
