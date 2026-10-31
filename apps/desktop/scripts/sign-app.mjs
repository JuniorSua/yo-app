// Signs the packaged Yo.app in release/, or the app given as the argument.
//
// A stable signing identity matters: macOS ties privacy permissions (Files & Folders, later Contacts,
// Calendars…) to the app's signature, so an ad-hoc signature that changes every build would make
// macOS forget them. Identity: $YO_SIGN_IDENTITY, else the first "Apple Development" identity in the
// login keychain (free with an Apple ID), else ad-hoc as a last resort. Only the name is printed.
//
// Ad-hoc on purpose: YO_ADHOC_SIGN=1 (or YO_SIGN_IDENTITY=-). The public builds on GitHub Releases are made
// this way (.github/workflows/release.yml): there is no paid Developer ID, so users OK them once (Open Anyway
// in Privacy & Security), and they update by downloading (the github update channel), not through Squirrel.
//
// Nested code is signed one file at a time, deepest first, and the app bundle last. `codesign --deep` is only
// for checking a signature: using it to sign re-signs every nested binary and drops entitlements applied
// earlier. limactl (and lima-driver-vz, when a build ships it) needs com.apple.security.virtualization or
// Apple's Virtualization framework refuses to start the Linux VM. Lima's own Makefile ad-hoc signs limactl
// the same way, without the hardened runtime.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { macAppPath } from "./bundle-identity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENTITLEMENTS = path.join(here, "..", "entitlements", "lima-vz.plist");

/** Mach-O magics, big-endian as they appear on disk (fat and thin, both endians). */
const MACHO_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
/** Fat headers share CAFEBABE with Java class files. Only executable fat files are signed. */
const FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca]);
const BUNDLE_SUFFIXES = [".app", ".framework", ".xpc", ".appex"];

export function machoMagic(buf) {
  if (!buf || buf.length < 4) return null;
  return buf.readUInt32BE(0);
}

/** True for a Mach-O (or an executable fat binary). Java .class files start with CAFEBABE and are skipped. */
export function shouldSignFile(buf, mode) {
  const magic = machoMagic(buf);
  if (magic == null || !MACHO_MAGICS.has(magic)) return false;
  if (FAT_MAGICS.has(magic) && (mode & 0o111) === 0) return false;
  return true;
}

function isBundleName(name) {
  return BUNDLE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Nested bundles and Mach-O files inside `app`, deepest path first. The app itself is not included.
 * Symlinks are skipped so a framework's Versions/Current alias is not signed twice.
 */
export function collectSignTargets(app) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (isBundleName(ent.name)) found.push(full);
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      let buf;
      let mode = 0;
      try {
        const st = fs.statSync(full);
        mode = st.mode;
        const fd = fs.openSync(full, "r");
        try {
          buf = Buffer.alloc(4);
          fs.readSync(fd, buf, 0, 4, 0);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      if (shouldSignFile(buf, mode)) found.push(full);
    }
  };
  walk(app);
  found.sort((a, b) => {
    const depth = (p) => p.split(path.sep).length;
    const byDepth = depth(b) - depth(a);
    if (byDepth !== 0) return byDepth;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return found;
}

/** Extra codesign flags for one target. Never includes --deep. */
export function signArgs(target, entitlements = ENTITLEMENTS) {
  const base = path.basename(target);
  if (base === "limactl" || base === "lima-driver-vz") return ["--entitlements", entitlements];
  if (base === "YoDeviceBridge") return ["--identifier", "dev.yo.app.devicebridge"];
  return [];
}

/** Nested targets deepest-first, then the app bundle. Each `args` list is what codesign gets besides the target. */
export function signPlan(app, entitlements = ENTITLEMENTS) {
  return [...collectSignTargets(app), app].map((target) => ({
    target,
    args: signArgs(target, entitlements),
  }));
}

export function invokedDirectly(metaUrl = import.meta.url, argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(path.resolve(entry)).href;
}

function findIdentity() {
  if (process.env.YO_ADHOC_SIGN === "1") return "-";
  if (process.env.YO_SIGN_IDENTITY) return process.env.YO_SIGN_IDENTITY;
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const m = /"(Apple Development: [^"]+)"/.exec(out) ?? /"(Developer ID Application: [^"]+)"/.exec(out);
    if (m?.[1]) return m[1];
  } catch {
    /* no keychain identities */
  }
  return "-";
}

function main() {
  const app = process.argv[2] ? path.resolve(process.argv[2]) : macAppPath(path.join(here, ".."));
  if (!fs.existsSync(app)) {
    console.error(`Not found: ${app}`);
    process.exit(1);
  }
  if (!fs.existsSync(ENTITLEMENTS)) {
    console.error(`Not found: ${ENTITLEMENTS}`);
    process.exit(1);
  }
  const identity = findIdentity();
  const plan = signPlan(app);
  for (const step of plan) {
    if (step.args.includes("--deep")) {
      console.error("Refusing to sign with --deep (it would drop limactl's virtualization entitlement).");
      process.exit(1);
    }
    execFileSync("codesign", ["--force", "--timestamp=none", "--sign", identity, ...step.args, step.target], {
      stdio: "inherit",
    });
  }
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const how = identity === "-" ? "an ad-hoc signature (permissions won't persist across builds)" : identity;
  console.log(`Signed ${path.basename(app)} with ${how}`);
}

if (invokedDirectly()) main();
