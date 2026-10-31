// Switch the site's absolute URLs (link previews and canonical links) to a new address, in one command:
//   node site/scripts/set-domain.mjs https://yo.example
// It reads the current address from index.html's canonical link and replaces it in every site/*.html page.
// Everything else on the site uses relative links, so this is the only site change a custom domain needs.
// Then deploy, and update the places outside site/ that it lists at the end. Not deployed (.vercelignore).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
let next;
try {
  next = new URL(arg);
} catch {
  console.error("Usage: node site/scripts/set-domain.mjs https://your-domain");
  process.exit(1);
}
if (next.protocol !== "https:" || next.pathname !== "/" || next.search || next.hash) {
  console.error("Give just the https address, like https://yo.example (no path).");
  process.exit(1);
}
const to = next.origin;
const canonical = readFileSync(join(siteDir, "index.html"), "utf8").match(
  /<link rel="canonical" href="(https:\/\/[^/"]+)\/"/,
);
if (!canonical) {
  console.error("Couldn't find the canonical link in index.html.");
  process.exit(1);
}
const from = canonical[1];
if (from === to) {
  console.log(`The site already uses ${to}.`);
  process.exit(0);
}
let total = 0;
for (const name of readdirSync(siteDir).filter((f) => f.endsWith(".html"))) {
  const file = join(siteDir, name);
  const text = readFileSync(file, "utf8");
  const count = text.split(from).length - 1;
  if (!count) continue;
  writeFileSync(file, text.replaceAll(from, to));
  total += count;
  console.log(`${name}: ${count} changed`);
}
console.log(`\nDone: ${from} -> ${to} (${total} places). Now:`);
console.log("  1. Serve the site and run site/scripts/smoke.mjs, then deploy (site/README.md, Deploy).");
console.log("  2. Outside site/, change the old address in: README.md (the website link),");
console.log("     the App Store listing files (maintainer docs), and in App Store Connect:");
console.log("     Support URL, Marketing URL and Privacy Policy URL.");
console.log("  3. Stripe Payment Link: After payment → redirect to the new address + /thanks.");
