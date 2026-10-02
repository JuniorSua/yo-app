// Renders the Yo logo and the agent-template avatars from packages/avatar to static SVGs for the site.
// Run from the repo root (needs the workspace node_modules):
//   npx tsx --tsconfig packages/avatar/tsconfig.json site/scripts/export-art.tsx site/assets
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.cwd();
const out = resolve(process.argv[2] ?? "site/assets");
const req = createRequire(resolve(root, "packages/avatar/package.json"));
const React = req("react");
const { renderToStaticMarkup } = req("react-dom/server");
const { AGENT_TEMPLATES, Avatar, YoLogo } = await import(resolve(root, "packages/avatar/src/index.ts"));

// Avatars paint outside their 0..100 box (headsets, ground shadows). The app shows that with overflow:visible, but an
// <img> clips it. One shared padded box keeps every character uncropped, at the same scale, on the same ground line.
const AVATAR_BOX = 'viewBox="-6 -6 112 112"';
// The logo paints roughly x 12..90, y 14..96. Crop to that so it sits flush with text.
const LOGO_BOX = 'viewBox="8 12 86 86"';

const render = (component: unknown, props: Record<string, unknown>, box: string) =>
  renderToStaticMarkup(React.createElement(component, props))
    .replace(/<style[\s\S]*?<\/style>/g, "")
    // The "waiting" ring is hidden by the app's avatar CSS, which a standalone SVG doesn't have.
    .replace(/<circle class="yo-av-ring"[^>]*?(\/>|><\/circle>)/g, "")
    .replace('viewBox="0 0 100 100"', box)
    .replace(/<svg(?![^>]*xmlns=) /, '<svg xmlns="http://www.w3.org/2000/svg" ');

mkdirSync(resolve(out, "avatars"), { recursive: true });
writeFileSync(resolve(out, "logo.svg"), render(YoLogo, { size: 64, animated: false }, LOGO_BOX));
for (const t of AGENT_TEMPLATES) {
  writeFileSync(
    resolve(out, "avatars", `${t.id}.svg`),
    render(Avatar, { avatar: t.avatar, size: 128, animated: false }, AVATAR_BOX),
  );
}
console.log(`Wrote logo + ${AGENT_TEMPLATES.length} avatars to ${out}`);
