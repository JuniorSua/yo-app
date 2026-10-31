import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { build } from "esbuild";
import { appVersion, buildId, snapshotVersion } from "../../scripts/build-info.mjs";

const id = buildId();

/**
 * 1Password's SDK core is WebAssembly that its loader reads from a file next to itself (`core_bg.wasm`). Bundled,
 * it's read instead from `dist/onepassword-core.wasm.br` (brotli, ~14 MB → ~3 MB) next to core.mjs, only the first
 * time 1Password is used. A separate file rather than embedded in core.mjs: embedded, it cost every core ~20 MB of
 * memory even with 1Password off. It ships wherever core.mjs does (Yo.app's core folder, the home-server image).
 */
export const ONE_PASSWORD_WASM = "onepassword-core.wasm.br";
const embedOnePasswordWasm = {
  name: "onepassword-wasm",
  setup(b) {
    b.onLoad({ filter: /[\\/]@1password[\\/]sdk-core[\\/]nodejs[\\/]core\.js$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      const load =
        /const path = require\('path'\)\.join\(__dirname, 'core_bg\.wasm'\);\s*const bytes = require\('fs'\)\.readFileSync\(path\);/;
      if (!load.test(src))
        throw new Error("@1password/sdk-core changed how it loads its wasm: update build.mjs");
      const wasm = readFileSync(path.join(path.dirname(args.path), "core_bg.wasm"));
      mkdirSync("dist", { recursive: true });
      writeFileSync(
        path.join("dist", ONE_PASSWORD_WASM),
        zlib.brotliCompressSync(wasm, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
      );
      return {
        contents: src.replace(
          load,
          () =>
            `const bytes = require("zlib").brotliDecompressSync(require("fs").readFileSync(new URL(${JSON.stringify(`./${ONE_PASSWORD_WASM}`)}, __yoCoreUrl)));`,
        ),
        loader: "js",
      };
    });
  },
};

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/core.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: {
    js: "import { createRequire as __yoCreateRequire } from 'node:module'; const require = __yoCreateRequire(import.meta.url); const __yoCoreUrl = import.meta.url;",
  },
  external: ["bufferutil", "utf-8-validate"],
  plugins: [embedOnePasswordWasm],
  // Served at /api/version so open UIs notice a deploy (see src/http/updates.ts).
  // A public snapshot (it has a VERSION file) files bug reports to the public repo by default.
  // __YO_VERSION__: the release number ("2.0.<count>", or the snapshot's VERSION) that bug reports quote.
  define: {
    __YO_BUILD__: JSON.stringify(id),
    __YO_PUBLIC__: JSON.stringify(snapshotVersion() !== null),
    __YO_VERSION__: JSON.stringify(appVersion(null)),
  },
});
console.log(`built dist/core.mjs (build ${id ?? "unknown"})`);
