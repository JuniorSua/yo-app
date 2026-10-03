import { build } from "esbuild";
import { appVersion, buildId, snapshotVersion } from "../../scripts/build-info.mjs";

const id = buildId();

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/core.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: {
    js: "import { createRequire as __yoCreateRequire } from 'node:module'; const require = __yoCreateRequire(import.meta.url);",
  },
  external: ["bufferutil", "utf-8-validate"],
  // Served at /api/version so open UIs notice a deploy (see src/http/updates.ts).
  // A public snapshot (it has a VERSION file) files bug reports to the public repo by default.
  // __YO_VERSION__: the release number ("0.1.<count>", or the snapshot's VERSION) that bug reports quote.
  define: {
    __YO_BUILD__: JSON.stringify(id),
    __YO_PUBLIC__: JSON.stringify(snapshotVersion() !== null),
    __YO_VERSION__: JSON.stringify(appVersion(null)),
  },
});
console.log(`built dist/core.mjs (build ${id ?? "unknown"})`);
