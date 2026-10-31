// Bundles agentd + MCP shims with esbuild into dist/, and writes dist/package.json listing the
// runtime externals (native / self-locating packages) that must be installed next to the bundles.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");

/**
 * Packages that are NOT bundled:
 *  - node-pty: native addon
 *  - @anthropic-ai/claude-agent-sdk: locates its platform-specific `claude` binary relative to itself
 * Everything else (ws, zod, MCP SDK, ACP SDK, @yo/contracts) is bundled.
 */
const RUNTIME_EXTERNALS = ["node-pty", "@anthropic-ai/claude-agent-sdk"];
const OPTIONAL_NATIVE = ["bufferutil", "utf-8-validate"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    agentd: "src/main.ts",
    "yo-mcp": "src/mcp/yo-mcp.ts",
    "desktop-mcp": "src/mcp/desktop-mcp.ts",
  },
  outdir: dist,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "none",
  external: [...RUNTIME_EXTERNALS, ...OPTIONAL_NATIVE],
  // CJS deps bundled into ESM need a real `require` for node builtins.
  banner: {
    js: "import { createRequire as __yoCreateRequire } from 'node:module'; const require = __yoCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

const deps = {};
for (const name of RUNTIME_EXTERNALS) {
  const v = pkg.dependencies?.[name];
  if (!v) throw new Error(`external ${name} missing from package.json dependencies`);
  deps[name] = v;
}
writeFileSync(
  path.join(dist, "package.json"),
  `${JSON.stringify({ name: "yo-agentd-runtime", private: true, type: "module", version: pkg.version, dependencies: deps }, null, 2)}\n`,
);
console.log("externals:", deps);
