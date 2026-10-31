/** The Page the mock's "visualize …" scenario makes (create_page): inline SVG, no network, like a real one. */
export function samplePageHtml(title: string): string {
  const hours = [2, 1, 1, 0, 0, 1, 3, 6, 9, 12, 10, 8, 11, 14, 12, 9, 10, 13, 17, 21, 18, 12, 7, 4];
  const max = Math.max(...hours);
  const bars = hours
    .map((v, h) => {
      const height = Math.round((v / max) * 180);
      const best = v === max;
      return `<g><rect x="${h * 26 + 8}" y="${200 - height}" width="18" height="${height}" rx="4" fill="${best ? "#f97316" : "#6366f1"}" opacity="${best ? 1 : 0.75}"><title>${h}:00 — ${v} posts</title></rect>${h % 3 === 0 ? `<text x="${h * 26 + 17}" y="218" text-anchor="middle">${h}</text>` : ""}</g>`;
    })
    .join("");
  const esc = title.replace(/[<&>"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc}</title><style>
body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fbfaf7;color:#1f1d1a}
main{max-width:720px;margin:0 auto;padding:32px 24px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:#77736b;margin:0 0 24px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
.card{background:#fff;border:1px solid #ebe8e1;border-radius:14px;padding:14px}
.card b{display:block;font-size:22px}
.card span{color:#77736b;font-size:13px}
svg{width:100%;height:auto;background:#fff;border:1px solid #ebe8e1;border-radius:14px}
svg text{font-size:10px;fill:#9a958c}
@media (prefers-color-scheme:dark){body{background:#1c1b19;color:#ecebe7}.card,svg{background:#252421;border-color:#34322e}}
</style></head><body><main>
<h1>${esc}</h1><p class="sub">Your last 30 days of posts, by hour of day.</p>
<div class="cards"><div class="card"><b>7 pm</b><span>Best hour</span></div>
<div class="card"><b>214</b><span>Posts</span></div><div class="card"><b>+38%</b><span>Replies after 6 pm</span></div></div>
<svg viewBox="0 0 632 228" role="img" aria-label="Posts by hour">${bars}</svg>
<p class="sub" style="margin-top:16px">Evenings win: posts between 6 and 8 pm got the most replies. Mornings are quiet.</p>
</main></body></html>`;
}

const BASE_CSS = `body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fbfaf7;color:#1f1d1a}
@media (prefers-color-scheme:dark){body{background:#1c1b19;color:#ecebe7}}`;
const esc = (s: string) => s.replace(/[<&>"]/g, "");

/** The mock's other kinds of Page (the Make gallery's variety): a slide, a doc and a design, all made up. */
export function sampleKindHtml(title: string, kind: string | undefined): string {
  const t = esc(title);
  if (kind === "slides")
    return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>${BASE_CSS}
.slide{min-height:100vh;box-sizing:border-box;padding:64px 72px;display:flex;flex-direction:column;justify-content:center;background:linear-gradient(135deg,#1e1b4b,#7c3aed);color:#fff}
.k{font-size:14px;letter-spacing:.14em;text-transform:uppercase;opacity:.75;margin:0 0 18px}
h1{font-size:64px;line-height:1.05;margin:0 0 22px;letter-spacing:-.03em;max-width:820px}
p{font-size:22px;opacity:.85;margin:0;max-width:680px}
.dots{display:flex;gap:8px;margin-top:48px}.dots i{width:10px;height:10px;border-radius:9px;background:#fff;opacity:.35}.dots i:first-child{opacity:1}
</style></head><body><section class="slide"><p class="k">Slide 1 of 6</p><h1>${t}</h1><p>Six slides, one idea each. Here is where it starts.</p><div class="dots"><i></i><i></i><i></i><i></i><i></i><i></i></div></section></body></html>`;
  if (kind === "doc")
    return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>${BASE_CSS}
main{max-width:680px;margin:0 auto;padding:48px 28px}h1{font-size:32px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:#77736b;margin:0 0 28px}h2{font-size:19px;margin:28px 0 8px}li{margin:6px 0}
</style></head><body><main><h1>${t}</h1><p class="sub">Updated today · 4 min read</p>
<h2>Two weeks before</h2><ul><li>Book the movers for Saturday morning</li><li>Forward mail to the new address</li><li>Order boxes and packing tape</li></ul>
<h2>Moving week</h2><ul><li>Pack the kitchen last</li><li>Take photos of the old place for the deposit</li><li>Set up internet at the new place for Monday</li></ul>
<h2>After</h2><p>Update the address with the bank, the car insurance and the dentist.</p></main></body></html>`;
  if (kind === "design")
    return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>${BASE_CSS}
main{padding:40px;display:grid;grid-template-columns:1.2fr 1fr;gap:28px;align-items:center;min-height:100vh;box-sizing:border-box;background:#f3efe8}
.hero{border-radius:28px;background:linear-gradient(160deg,#fde68a,#f97316);aspect-ratio:4/3;box-shadow:0 30px 60px -30px #9a3412}
h1{font-size:46px;line-height:1.05;margin:0 0 14px;letter-spacing:-.03em;color:#1f1d1a}
p{color:#57534e;font-size:18px;margin:0 0 22px}.btn{display:inline-block;background:#1f1d1a;color:#fff;border-radius:999px;padding:12px 22px;font-weight:600}
.sw{display:flex;gap:10px;margin-top:26px}.sw i{width:34px;height:34px;border-radius:10px}
</style></head><body><main><div><h1>${t}</h1><p>Warm, calm and bright: a home page for the bakery's new season.</p><span class="btn">Order for pickup</span>
<div class="sw"><i style="background:#f97316"></i><i style="background:#fde68a"></i><i style="background:#1f1d1a"></i><i style="background:#f3efe8;border:1px solid #d6d3d1"></i></div></div><div class="hero"></div></main></body></html>`;
  if (kind === "page")
    return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>${BASE_CSS}
header{padding:56px 32px 36px;background:#0f766e;color:#fff}h1{font-size:40px;margin:0 0 8px;letter-spacing:-.02em}
header p{margin:0;opacity:.85}main{padding:28px 32px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.c{border:1px solid #e7e5e4;border-radius:16px;padding:16px;background:#fff}.c b{display:block;margin-bottom:4px}
@media (prefers-color-scheme:dark){.c{background:#252421;border-color:#34322e}}
</style></head><body><header><h1>${t}</h1><p>Saturday, 9 am to 1 pm · Riverside lot</p></header><main>
<div class="c"><b>Fresh produce</b>Twelve farms, all within 50 miles.</div><div class="c"><b>Live music</b>Acoustic sets every hour.</div><div class="c"><b>Kids' corner</b>Face paint and a petting zoo.</div></main></body></html>`;
  return samplePageHtml(title);
}
