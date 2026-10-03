// Smoke test for the static site. Serve site/ first, then from the repo root:
//   python3 -m http.server 5471 -d site &
//   node site/scripts/smoke.mjs http://localhost:5471
// Checks: no console errors, the links and buttons are there, the "Set up with your agent" chip copies the exact
// prompt (and falls back without the clipboard API), the $10 button stays hidden until config.js has a valid Stripe
// Payment Link, no horizontal scroll at 375px, the demo's first run goes end to end, and no Grok or personal data.
// Not deployed (.vercelignore drops scripts/).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:5471";
const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES = "https://github.com/JuniorSua/yo-app/releases/latest";
const REPO = "https://github.com/JuniorSua/yo-app";
const PROMPT =
  "Set up Yo for me. Follow the setup prompt at https://github.com/JuniorSua/yo-app/blob/main/SETUP_PROMPT.md";

let failures = 0;
const passed = [];
const check = (name, ok, detail = "") => {
  if (ok) passed.push(name);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
};

const browser = await chromium.launch();

async function open(width, { config, init, clipboard } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
    permissions: clipboard ? ["clipboard-read", "clipboard-write"] : [],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  if (config != null)
    await page.route("**/config.js", (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: `const STRIPE_PAYMENT_LINK = ${JSON.stringify(config)};\nwindow.YO_SITE = Object.freeze({ STRIPE_PAYMENT_LINK });\n`,
      }),
    );
  if (init) await page.addInitScript(init);
  await page.goto(base, { waitUntil: "networkidle" });
  return { page, errors, context };
}

// ------------------------------------------------------------ Desktop pass
{
  const { page, errors, context } = await open(1280, { clipboard: true });

  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
  check(
    "every <a> has a non-empty href",
    hrefs.every((h) => h && h !== "#"),
    JSON.stringify(hrefs),
  );
  const ids = new Set(await page.$$eval("[id]", (els) => els.map((e) => e.id)));
  const missing = hrefs.filter((h) => h.startsWith("#") && !ids.has(h.slice(1)));
  check("every in-page link has a target", missing.length === 0, missing.join(", "));
  check(
    "Download links to the latest release (and never says macOS)",
    (await page.locator(`a[href="${RELEASES}"]`, { hasText: /^\s*Download\s*$/ }).count()) >= 3 &&
      (await page.locator("a", { hasText: "Download for macOS" }).count()) === 0,
  );
  check(
    "View on GitHub links to the repo",
    (await page.locator(`a[href="${REPO}"]`, { hasText: "View on GitHub" }).count()) >= 2,
  );
  check(
    "hero Download is visible",
    await page.locator(".hero-actions a", { hasText: "Download" }).isVisible(),
  );
  check(
    "hero View on GitHub is visible",
    await page.locator(".hero-actions a", { hasText: "View on GitHub" }).isVisible(),
  );
  check("nav Download is visible", await page.locator(`.nav-end a[href="${RELEASES}"]`).isVisible());
  for (const id of [
    "top",
    "demo",
    "how",
    "why",
    "agents",
    "requirements",
    "privacy",
    "pricing",
    "faq",
    "download",
  ])
    check(`section #${id} exists`, ids.has(id));
  const github = await page
    .locator('a[href^="https://github.com/"]')
    .evaluateAll((as) => as.map((a) => a.href));
  check(
    "GitHub links all point at JuniorSua/yo-app",
    github.every((h) => h.startsWith(REPO)),
    github.join(", "),
  );

  // Copy chip
  const chip = page.getByRole("button", { name: "Set up with your agent" });
  check("copy chip is a visible button", await chip.isVisible());
  check("copy chip carries the exact prompt", (await chip.getAttribute("data-copy-text")) === PROMPT);
  await chip.click();
  const note = page.locator("[data-setup-note]");
  await note.filter({ hasText: "Copied" }).waitFor({ timeout: 3000 });
  check(
    "copy note says where to paste",
    (await note.textContent()) === "Copied: paste it into Claude Code or Codex",
  );
  check("copy note is a live region", (await note.getAttribute("aria-live")) === "polite");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("clipboard holds exactly the prompt", clip === PROMPT, JSON.stringify(clip));

  // $10 button while STRIPE_PAYMENT_LINK is empty
  check("pay button hidden while the link is empty", !(await page.locator("[data-pay]").isVisible()));
  check("'Payments coming soon' shown instead", await page.locator(".soon-pill").isVisible());

  // Requirements copy matches docs/REQUIREMENTS.md
  const req = (await page.locator("#requirements").innerText()).replace(/\s+/g, " ");
  for (const want of [
    "Memory (RAM) 16 GB 32 GB",
    "Memory for the agent's computer",
    "2 GB 4 GB",
    "Apple M1, or a 64-bit Intel or AMD chip with 4 cores",
    "Free disk space 10 GB 20 GB",
    "macOS 13 Ventura",
    "Windows and Linux: coming soon",
  ])
    check(`requirements say "${want}"`, req.includes(want), req);
  const pricing = (await page.locator("#pricing").innerText()).replace(/\s+/g, " ");
  check("$10 line", pricing.includes("Your $10 supports Yo's ongoing development and updates."));
  check("pricing says Apache-2.0", pricing.includes("Apache-2.0"));
  const body = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check(
    "no free version is offered",
    !/build it yourself|free download|for free/i.test(body) && !/\bfree\b/i.test(pricing),
    body.match(/.{40}(build it yourself|free download|for free).{40}/i)?.[0],
  );
  // The setup chip is the hero's first and highlighted action.
  const heroOrder = await page.locator(".hero-copy").evaluate((h) => {
    const chip = h.querySelector(".setup-copy");
    const dl = h.querySelector(".hero-actions a");
    return chip && dl ? chip.compareDocumentPosition(dl) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  check("setup chip comes before Download in the hero", heroOrder !== 0);

  // First-open help
  await page.locator("[data-first-open]").click();
  check("first-open link opens the FAQ entry", await page.locator("#first-open").evaluate((d) => d.open));
  check(
    "first-open shows the xattr command",
    (await page.locator("#first-open code").textContent()) ===
      "xattr -dr com.apple.quarantine /Applications/Yo.app",
  );
  const firstOpen = await page.locator("#first-open").textContent();
  check(
    "first-open leads with Open Anyway (right-click → Open no longer works on macOS 15+)",
    firstOpen.indexOf("Open Anyway") !== -1 &&
      firstOpen.indexOf("Open Anyway") < firstOpen.indexOf("right-click"),
  );

  // Link previews and icons
  const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
  check("og:image is an absolute https URL", /^https:\/\/[^/]+\/assets\/og\.png$/.test(ogImage), ogImage);
  for (const icon of [
    "/assets/og.png",
    "/assets/apple-touch-icon.png",
    "/assets/favicon-32.png",
    "/assets/logo.svg",
  ]) {
    const r = await page.request.get(new URL(icon, base).href);
    check(`${icon} is served`, r.ok(), String(r.status()));
  }

  // Demo: first run end to end
  const demo = page.locator("[data-demo]");
  await demo.scrollIntoViewIfNeeded();
  check("demo opens on Connect your model", await demo.getByText("Connect your model").isVisible());
  await demo.locator('[data-pick="claude"]').click();
  check(
    "Claude path shows claude setup-token",
    await demo.getByText("claude setup-token", { exact: true }).isVisible(),
  );
  await demo.locator("[data-connect]").click();
  await demo.getByText("Claude is connected").waitFor();
  await demo.getByRole("button", { name: "Continue" }).click();
  check(
    "first agent says Let's set up my computer",
    await demo.getByText("Looks like we have a model connected. Let's set up my computer.").isVisible(),
  );
  check("Cloud card is disabled", await demo.getByRole("button", { name: /Cloud/ }).isDisabled());
  check(
    "Home server card is marked Advanced",
    await demo.getByRole("button", { name: /Home server.*Advanced/ }).isVisible(),
  );
  await demo.locator('[data-where="local"]').click();
  await demo.locator("[data-start]").click();
  await demo.getByRole("button", { name: "Start chatting →" }).click();
  check("first run ends in the app", await demo.locator("[data-list] .a-item").first().isVisible());
  // ChatGPT path from a fresh load, then Skip.
  await page.reload({ waitUntil: "networkidle" });
  await demo.locator('[data-pick="chatgpt"]').click();
  check(
    "ChatGPT path shows the Codex sign-in",
    await demo
      .getByText("mkdir -p ~/.yo/codex && CODEX_HOME=~/.yo/codex codex login", { exact: true })
      .isVisible(),
  );
  await demo.getByRole("button", { name: "Skip to the app" }).click();
  check("Skip to the app closes the first run", !(await demo.locator(".a-first").isVisible()));

  // Content hygiene
  const text = await page.locator("body").innerText();
  const html = await page.content();
  check("no Grok anywhere", !/grok/i.test(html));
  check("no beta / early access left", !/private beta|early access/i.test(text));
  const pii = [
    /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/,
    /\.ts\.net\b/,
    /\/home\/[a-z]/,
    /\/Users\//,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
  ];
  for (const f of ["index.html", "site.js", "demo.js", "config.js", "styles.css", "demo.css"]) {
    const src = readFileSync(resolve(siteDir, f), "utf8");
    const hit = pii.find((re) => re.test(src));
    check(`no personal data in ${f}`, !hit, String(hit));
  }
  const vercel = JSON.parse(readFileSync(resolve(siteDir, "vercel.json"), "utf8"));
  const headers = vercel.headers.flatMap((h) => h.headers.map((x) => x.key));
  check(
    "vercel.json keeps the security headers",
    ["X-Content-Type-Options", "Referrer-Policy"].every((k) => headers.includes(k)),
  );

  check("no console errors (desktop)", errors.length === 0, errors.join(" | "));
  await context.close();
}

// -------------------------------------------- Clipboard API unavailable
{
  const { page, errors, context } = await open(1280, {
    init: () => {
      Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
      document.execCommand = () => false;
    },
  });
  await page.getByRole("button", { name: "Set up with your agent" }).click();
  const fb = page.locator("[data-setup-fallback]");
  check("fallback field appears without the clipboard API", await fb.isVisible());
  check("fallback field holds the exact prompt", (await fb.inputValue()) === PROMPT);
  check(
    "fallback text is selected",
    await fb.evaluate((i) => i.selectionEnd - i.selectionStart === i.value.length),
  );
  check("no console errors (fallback)", errors.length === 0, errors.join(" | "));
  await context.close();
}

// ------------------------------------------------- STRIPE_PAYMENT_LINK set
{
  const link = "https://buy.stripe.com/test_00abcDEF123";
  const { page, errors, context } = await open(1280, { config: link });
  const pay = page.locator("[data-pay]");
  check("pay button shown with a valid link", await pay.isVisible());
  check("pay button points at the link", (await pay.getAttribute("href")) === link);
  check("'coming soon' hidden once the link is set", !(await page.locator(".soon-pill").isVisible()));
  check("no console errors (paid)", errors.length === 0, errors.join(" | "));
  await context.close();
}
for (const bad of [
  "http://buy.stripe.com/abc",
  "https://evil.example/buy.stripe.com/abc",
  "https://buy.stripe.com.evil.example/abc",
  "https://user@buy.stripe.com/abc",
  "javascript:alert(1)",
  "https://buy.stripe.com/",
]) {
  const { page, context } = await open(1280, { config: bad });
  check(`pay button stays hidden for ${bad}`, !(await page.locator("[data-pay]").isVisible()));
  await context.close();
}

// ------------------------------------------------------------- Mobile 375
{
  const { page, errors, context } = await open(375);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal scroll at 375px", (await overflow()) <= 0, `${await overflow()}px`);
  await page.locator(".nav-menu").click();
  const menu = page.locator("[data-mobile-menu]");
  check("mobile menu opens", await menu.isVisible());
  check("mobile menu has Download", await menu.locator(`a[href="${RELEASES}"]`).isVisible());
  await page.locator(".nav-menu").click();
  check(
    "copy chip visible at 375px",
    await page.getByRole("button", { name: "Set up with your agent" }).isVisible(),
  );
  const demo = page.locator("[data-demo]");
  await demo.scrollIntoViewIfNeeded();
  await demo.locator('[data-pick="claude"]').click();
  check("no horizontal scroll in the demo's connect steps", (await overflow()) <= 0, `${await overflow()}px`);
  await demo.locator("[data-connect]").click();
  await demo.getByRole("button", { name: "Continue" }).click();
  await demo.locator('[data-where="local"]').click();
  await demo.locator("[data-start]").waitFor();
  check("no horizontal scroll in the setup chat", (await overflow()) <= 0, `${await overflow()}px`);
  check("no console errors (mobile)", errors.length === 0, errors.join(" | "));
  await context.close();
}

await browser.close();
console.log(`${passed.length} checks passed, ${failures} failed`);
for (const p of passed) console.log(`  ok  ${p}`);
process.exit(failures ? 1 : 0);
