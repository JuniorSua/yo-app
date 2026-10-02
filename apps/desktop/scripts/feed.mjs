// The electron-updater "generic" feed for Yo.app: latest-mac.yml plus versioned zips. Pure helpers, used by
// publish-app.mjs and its tests.

/** Compare dotted numeric versions ("0.1.312" < "0.1.313" < "0.2.0"). */
export function compareVersions(a, b) {
  const pa = String(a)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** "Yo" + "0.1.312" -> "Yo-0.1.312-arm64-mac.zip" (electron-builder's naming; "arm64" picks the Apple-silicon file). */
export function zipName(productName, version) {
  return `${String(productName).replace(/[^A-Za-z0-9]+/g, "-")}-${version}-arm64-mac.zip`;
}

/** "Yo" + "0.1.312" -> the GitHub Release files (make-dist.mjs): Yo-0.1.312-arm64.dmg / .zip. */
export function distNames(productName, version) {
  const base = `${String(productName).replace(/[^A-Za-z0-9]+/g, "-")}-${version}-arm64`;
  return { dmg: `${base}.dmg`, zip: `${base}.zip` };
}

/** The version in a feed zip name, or null for anything else. */
export function zipVersion(name) {
  return /-(\d+(?:\.\d+)+)-arm64-mac\.zip$/.exec(name)?.[1] ?? null;
}

/** Feed zips to delete so only the newest `keep` remain. */
export function zipsToPrune(names, keep = 2) {
  return names
    .filter((n) => zipVersion(n))
    .sort((a, b) => compareVersions(zipVersion(b), zipVersion(a)))
    .slice(keep);
}

/** latest-mac.yml as electron-updater reads it. `sha512` is base64, like electron-builder writes it. */
export function latestMacYml({ version, file, sha512, size, releaseDate }) {
  for (const [k, v] of Object.entries({ version, file, sha512 }))
    if (typeof v !== "string" || !v || /[\n'"]/.test(v)) throw new Error(`bad ${k}`);
  if (!Number.isInteger(size) || size <= 0) throw new Error("bad size");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}
