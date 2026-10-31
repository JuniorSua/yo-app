// Renders the Yo logo from packages/avatar to a static SVG for the site (assets/logo.svg, which export-og.mjs then
// turns into the PNG icons). The Softies in assets/softies/ are exported separately; see site/README.md.
// Run from the repo root (needs the workspace node_modules):
//   npx tsx --tsconfig packages/avatar/tsconfig.json site/scripts/export-art.tsx site/assets
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.cwd();
const out = resolve(process.argv[2] ?? "site/assets");
const req = createRequire(resolve(root, "packages/avatar/package.json"));
const React = req("react");
const { renderToStaticMarkup } = req("react-dom/server");
const { YoLogo } = await import(resolve(root, "packages/avatar/src/index.ts"));

// The logo paints roughly x 12..90, y 14..96. Crop to that so it sits flush with text.
const LOGO_BOX = 'viewBox="8 12 86 86"';

const svg = renderToStaticMarkup(React.createElement(YoLogo, { size: 64, animated: false }))
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace('viewBox="0 0 100 100"', LOGO_BOX)
  .replace(/<svg(?![^>]*xmlns=) /, '<svg xmlns="http://www.w3.org/2000/svg" ');
writeFileSync(resolve(out, "logo.svg"), svg);
console.log(`Wrote logo.svg to ${out}`);
