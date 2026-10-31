// Smoke test for the static site. Serve site/ first, then from the repo root:
//   python3 -m http.server 5190 -d site &
//   node site/scripts/smoke.mjs http://localhost:5190
// Checks:
// - The hero ("Switch models, not apps."), its Download and View on GitHub buttons, meta and link-preview tags.
// - Every Download link and the Windows and Linux install lines follow DOWNLOAD_TAG in config.js (plain hrefs,
//   so they work with JavaScript off). GitHub's API and the .dmg are mocked (nothing real downloads): a click on
//   a Mac starts the .dmg and shows the next-steps panel, falls back to the release page when the API fails.
//   Windows and Linux get their own install command with a working Copy button; phones get both.
// - Support Yo: "Sponsor monthly" is SPONSOR_LINK, "Chip in" shows only for a valid SUPPORT_ONCE_LINK.
// - No pricing anywhere: no "$10", no "Subscribe", no licence keys, no Stripe subscription links.
// - Every internal link and anchor on every page has a target; every GitHub link is the public repo (or Sponsors).
// - The Softies load and go inline; the model picker and the take-over demo work.
// - No horizontal scroll at 390px, light and dark, no console errors, no personal data.
// Not deployed (.vercelignore drops scripts/).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = (process.argv[2] ?? "http://localhost:5190").replace(/\/$/, "");
const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/JuniorSua/yo-app";
const read = (f) => readFileSync(resolve(siteDir, f), "utf8");
const configJs = read("config.js");
const constant = (name) => configJs.match(new RegExp(`const ${name} = "([^"]*)"`))?.[1];
const DOWNLOAD_TAG = constant("DOWNLOAD_TAG");
const SPONSOR_LINK = constant("SPONSOR_LINK");
const SUPPORT_ONCE_LINK = constant("SUPPORT_ONCE_LINK");
const SUPPORT_EMAIL = constant("SUPPORT_EMAIL");
if (DOWNLOAD_TAG == null || (DOWNLOAD_TAG !== "" && !/^v\d+\.\d+\.\d+$/.test(DOWNLOAD_TAG))) {
  console.error(`FAIL DOWNLOAD_TAG must be "" or vX.Y.Z, got ${JSON.stringify(DOWNLOAD_TAG)}`);
  process.exit(1);
}
const RELEASES = DOWNLOAD_TAG ? `${REPO}/releases/tag/${DOWNLOAD_TAG}` : `${REPO}/releases/latest`;
const RELEASE_API = DOWNLOAD_TAG
  ? `https://api.github.com/repos/JuniorSua/yo-app/releases/tags/${DOWNLOAD_TAG}`
  : "https://api.github.com/repos/JuniorSua/yo-app/releases/latest";
const assetUrl = (name) =>
  DOWNLOAD_TAG
    ? `${REPO}/releases/download/${DOWNLOAD_TAG}/${name}`
    : `${REPO}/releases/latest/download/${name}`;
// The mocked .dmg uses the pinned tag when there is one. GitHub's answer supplies the file name; the page does not.
const TAG = DOWNLOAD_TAG || "v2.0.1";
const DMG_NAME = `Yo-${TAG.slice(1)}-arm64.dmg`;
const DMG = `${REPO}/releases/download/${TAG}/${DMG_NAME}`;
const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const OS = {
  mac: { platform: "macOS", ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}` },
  windows: { platform: "Windows", ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}` },
  linux: { platform: "Linux", ua: `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}` },
  // Safari has no userAgentData: the page goes by the user agent (and touch) alone.
  iphone: {
    platform: null,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
};
const INSTALL = {
  windows: `irm ${assetUrl("install.ps1")} | iex`,
  linux: `curl -fsSL ${assetUrl("install.sh")} | bash`,
};
const PC_GUIDE = `${REPO}#windows-and-linux-in-your-browser`;
const PROMPT = `Set up Yo for me. Follow the setup prompt at ${REPO}/blob/main/SETUP_PROMPT.md`;
const PAGES = ["index.html", "support.html", "terms.html", "privacy.html", "thanks.html", "404.html"];
const SCRIPTS = ["site.js", "contact.js", "config.js", "styles.css"];

let failures = 0;
const passed = [];
const check = (name, ok, detail = "") => {
  if (ok) passed.push(name);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
};

// ------------------------------------------------------------ Files
// The plain hrefs and install lines (no JS) must name the same tag config.js does.
{
  const hrefsFor = (src, attr) =>
    [...src.matchAll(/<a\b[^>]*>/g)]
      .filter((m) => m[0].includes(attr))
      .map((m) => m[0].match(/\bhref="([^"]*)"/)?.[1] ?? "");
  const index = read("index.html");
  const support = read("support.html");
  const thanks = read("thanks.html");
  const buttons = hrefsFor(index, "data-download");
  const direct = hrefsFor(index, "data-dl-direct");
  check(
    "index.html: every Download href is the pinned release",
    buttons.length === 4 && buttons.every((h) => h === RELEASES),
    JSON.stringify(buttons),
  );
  check(
    "index.html: direct download fallbacks are the pinned release",
    direct.length === 2 && direct.every((h) => h === RELEASES),
    JSON.stringify(direct),
  );
  check(
    "index.html: Windows and Linux install lines use the pinned tag",
    index.includes(INSTALL.windows) && index.includes(INSTALL.linux),
  );
  check(
    "support.html: Windows and Linux install lines use the pinned tag",
    support.includes(INSTALL.windows) && support.includes(INSTALL.linux),
  );
  const thanksHref = thanks.match(/<a class="btn btn-ink" href="([^"]*)">Download Yo<\/a>/)?.[1];
  check("thanks.html: Download href is the pinned release", thanksHref === RELEASES, thanksHref ?? "");
  if (DOWNLOAD_TAG) {
    for (const [name, src] of [
      ["index.html", index],
      ["support.html", support],
      ["thanks.html", thanks],
    ])
      check(`${name}: no /releases/latest while DOWNLOAD_TAG is set`, !src.includes("/releases/latest"));
    // One replace of the tag string: it lives only in these files, in these counts.
    const pinCounts = { "config.js": 1, "index.html": 8, "support.html": 2, "thanks.html": 1 };
    const found = new Map();
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(html|js|mjs|css|md|json)$/.test(ent.name)) {
          const n = readFileSync(p, "utf8").split(DOWNLOAD_TAG).length - 1;
          if (n) found.set(relative(siteDir, p), n);
        }
      }
    };
    walk(siteDir);
    const line = (entries) =>
      [...entries]
        .map(([file, n]) => `${file} ×${n}`)
        .sort()
        .join(", ");
    check(
      "DOWNLOAD_TAG appears only in config.js and the plain links",
      line(found) === line(Object.entries(pinCounts)),
      `expected ${line(Object.entries(pinCounts))}; found ${line(found) || "(none)"}`,
    );
  }

  // Support Yo links: Sponsor's plain href is SPONSOR_LINK; Chip in starts hidden (JS shows it for a real link).
  check(
    "config.js: SPONSOR_LINK is GitHub Sponsors",
    /^https:\/\/github\.com\/sponsors\/[A-Za-z0-9-]+$/.test(SPONSOR_LINK ?? ""),
    SPONSOR_LINK,
  );
  check("config.js: SUPPORT_ONCE_LINK exists", SUPPORT_ONCE_LINK != null);
  check("config.js: support email is support@theyoapp.com", SUPPORT_EMAIL === "support@theyoapp.com");
  check(
    "config.js: no Stripe subscription or portal links",
    !/STRIPE_PAYMENT_LINK|STRIPE_PORTAL_LINK|billing\.stripe\.com/.test(configJs),
  );
  for (const [name, src] of [
    ["index.html", index],
    ["thanks.html", thanks],
  ]) {
    const sponsors = hrefsFor(src, "data-sponsor");
    check(
      `${name}: Sponsor hrefs are SPONSOR_LINK`,
      sponsors.length >= 1 && sponsors.every((h) => h === SPONSOR_LINK),
      JSON.stringify(sponsors),
    );
  }
  const once = [...index.matchAll(/<a\b[^>]*data-support-once[^>]*>/g)].map((m) => m[0]);
  check(
    "index.html: Chip in starts hidden",
    once.length === 1 && once.every((t) => /\shidden(\s|>)/.test(t)),
    once.join(" "),
  );

  // No pricing anywhere a visitor can load.
  for (const f of [...PAGES, ...SCRIPTS]) {
    const src = read(f);
    check(`${f}: no "$10"`, !src.includes("$10"));
    check(`${f}: no "Subscribe"`, !/subscribe/i.test(src));
    check(`${f}: no monthly price`, !/\/month|a month\b|per month/i.test(src));
    check(
      `${f}: no licence key purchase`,
      !/license key|buy\.stripe\.com\/[A-Za-z0-9]|data-pay|data-portal/i.test(src),
    );
    check(`${f}: no free trial`, !/free trial/i.test(src));
  }
  check("index.html: no pricing section", !/id="pricing"|#pricing|Pricing/.test(index));
  // Removed files stay removed and unreferenced; the licence API stays for old 0.1 installs, unlinked.
  for (const gone of ["demo.js", "demo.css", "recover.js", "thanks.js", "assets/avatars"])
    check(`${gone} is gone`, !existsSync(resolve(siteDir, gone)));
  for (const kept of ["api/license/check.mjs", "api/license/session.mjs", "api/license/recover.mjs"])
    check(`${kept} is kept for old installs`, existsSync(resolve(siteDir, kept)));
  for (const f of [...PAGES, ...SCRIPTS]) {
    const src = read(f);
    check(
      `${f}: links nothing removed`,
      !/demo\.js|demo\.css|recover\.js|thanks\.js|assets\/avatars\/|\/api\/license/.test(src),
    );
  }

  // Terms and privacy: free software, gifts not purchases, the new date.
  const terms = read("terms.html").replace(/\s+/g, " ");
  for (const want of [
    "Effective October 30, 2026",
    "Apache License 2.0",
    "There's no price, no paid plan and no subscription to Yo.",
    "Support payments are non-refundable",
    "aren't tax-deductible",
    "doesn't buy goods, services, features",
  ])
    check(`terms say "${want}"`, terms.includes(want));
  // The owner, an individual, is the provider (his approved exception). Checked by shape: no name literal here.
  check("terms name the provider", /agreement between you and <b>Junior \w+<\/b>, an individual/.test(terms));
  const privacy = read("privacy.html").replace(/\s+/g, " ");
  check(
    "privacy covers support payments, and no licence check",
    privacy.includes('id="payments"') &&
      privacy.includes("Yo doesn't check a licence.") &&
      privacy.includes("Stripe's privacy policy") &&
      !/About once a day, the app checks/.test(privacy),
  );
  const supportPage = read("support.html");
  check(
    "help page points to Support Yo and covers old licence keys",
    supportPage.includes('href="/#support"') &&
      supportPage.includes('id="license-key"') &&
      !supportPage.includes('id="billing"'),
  );
  check(
    "Yo Phone is labelled Coming soon",
    index.includes("Coming soon") && supportPage.includes("The iPhone app and Yo Phone are in testing"),
  );

  // No personal data. The one public address allowed in the files: the support email.
  const pii = [
    /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/,
    /\.ts\.net\b/,
    /\/home\/[a-z]/,
    /\/Users\//,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
  ];
  for (const f of [...PAGES, ...SCRIPTS]) {
    const src = read(f).replaceAll("support@theyoapp.com", "");
    const hit = pii.find((re) => re.test(src));
    check(`no personal data in ${f}`, !hit, String(hit));
  }
  const vercel = JSON.parse(read("vercel.json"));
  const headers = vercel.headers.flatMap((h) => h.headers.map((x) => x.key));
  check(
    "vercel.json keeps the security headers",
    ["X-Content-Type-Options", "Referrer-Policy"].every((k) => headers.includes(k)),
  );
  check("vercel.json serves /privacy, /terms and /support (cleanUrls)", vercel.cleanUrls === true);
}

const browser = await chromium.launch();

// `api`: how the mocked GitHub API answers ("ok", "fail" or "nodmg"); `os`: the computer the visitor is on;
// `config`: replaces config.js ({ once, sponsor, email }).
async function open(
  width,
  { config, init, clipboard, api = "ok", os = "mac", height = 900, scheme = "light", path = "/" } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    colorScheme: scheme,
    permissions: clipboard ? ["clipboard-read", "clipboard-write"] : [],
    userAgent: OS[os].ua,
  });
  if (OS[os].platform)
    await context.addInitScript((platform) => {
      Object.defineProperty(Navigator.prototype, "userAgentData", {
        get: () => ({ platform, mobile: false }),
      });
    }, OS[os].platform);
  const github = { api: 0, dmg: 0, apiUrls: [] };
  await context.route("https://api.github.com/**", (r) => {
    github.api += 1;
    github.apiUrls.push(r.request().url().split("?")[0]);
    if (api === "fail") return r.fulfill({ status: 403, body: "rate limited" });
    const assets = [
      { name: `Yo-${TAG.slice(1)}-arm64.zip`, browser_download_url: DMG.replace(/dmg$/, "zip") },
    ];
    if (api !== "nodmg") assets.push({ name: DMG_NAME, browser_download_url: DMG });
    return r.fulfill({
      headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
      body: JSON.stringify({ tag_name: TAG, assets }),
    });
  });
  await context.route(`${REPO}/releases/download/**`, (r) => {
    github.dmg += 1;
    return r.fulfill({
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename=${DMG_NAME}`,
      },
      body: "not really a dmg",
    });
  });
  await context.route(RELEASES, (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>release page</title>release page" }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  if (config != null) {
    const { once = "", sponsor = "", email = "" } = config;
    await page.route("**/config.js", (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: `window.YO_SITE = Object.freeze({ SUPPORT_EMAIL: ${JSON.stringify(email)}, DOWNLOAD_TAG: ${JSON.stringify(DOWNLOAD_TAG)}, SUPPORT_ONCE_LINK: ${JSON.stringify(once)}, SPONSOR_LINK: ${JSON.stringify(sponsor)} });\n`,
      }),
    );
  }
  if (init) await page.addInitScript(init);
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  return { page, errors, context, github };
}

// Internal links: "/x" is site/x.html (cleanUrls on Vercel), "#id" must exist on that page.
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...read(file).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(file);
};
const brokenLinks = (hrefs, currentFile) =>
  hrefs.filter((h) => {
    if (h.startsWith("https://")) return false;
    if (h.startsWith("mailto:")) return h.split("?")[0] !== "mailto:support@theyoapp.com";
    const [path, hash] = h.split("#");
    const file = path === "" ? currentFile : path === "/" ? "index.html" : `${path.slice(1)}.html`;
    if (!existsSync(resolve(siteDir, file))) return true;
    return hash ? !idsOf(file).has(hash) : false;
  });

// JavaScript off: Download, GitHub and Sponsor work as plain links; Chip in stays hidden.
{
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  check(
    "no JS: hero Download is a link to the release",
    (await page.locator(".hero-actions a[data-download]").getAttribute("href")) === RELEASES,
  );
  check("no JS: Sponsor monthly is visible", await page.locator("#support [data-sponsor]").isVisible());
  check("no JS: Chip in is hidden", !(await page.locator("#support [data-support-once]").isVisible()));
  check("no JS: the Softies show as images", (await page.locator(".team img").count()) === 6);
  await context.close();
}

// ------------------------------------------------------------ Desktop pass
for (const scheme of ["light", "dark"]) {
  const { page, errors, context } = await open(1440, { scheme });
  const tag = `desktop ${scheme}`;
  check(`${tag}: no console errors`, errors.length === 0, errors.join(" | "));
  if (scheme === "dark") {
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("dark: the page is dark", bg === "rgb(18, 18, 18)", bg);
    await context.close();
    continue;
  }
  const h1 = (await page.locator("h1").innerText()).replace(/\s+/g, " ").trim();
  check("hero says Switch models, not apps.", h1 === "Switch models, not apps.", h1);
  check(
    "hero subline: free, open source, a team of agents, the subscriptions you already have",
    /free, open-source home for a team of AI agents that run on the subscriptions you already have: Claude, ChatGPT or Grok\./.test(
      (await page.locator(".hero-sub").innerText()).replace(/\s+/g, " "),
    ),
  );
  check("hero Download is visible", await page.locator(".hero-actions a[data-download]").isVisible());
  const gh = page.locator(".hero-actions a", { hasText: "View on GitHub" });
  check("hero View on GitHub goes to the repo", (await gh.getAttribute("href")) === REPO);
  check("nav Download is visible", await page.locator(`.nav-end a[href="${RELEASES}"]`).isVisible());
  for (const id of ["team", "models", "computer", "phone", "open-source", "support", "faq"])
    check(`section #${id} exists`, (await page.locator(`section#${id}`).count()) === 1);

  // Meta and link previews
  const meta = async (sel) => page.locator(sel).first().getAttribute("content");
  check("title", (await page.title()) === "Yo · Switch models, not apps.", await page.title());
  check("meta description", /free, open-source/.test((await meta('meta[name="description"]')) ?? ""));
  check("og:title", (await meta('meta[property="og:title"]')) === "Yo · Switch models, not apps.");
  check("og:description", ((await meta('meta[property="og:description"]')) ?? "").length > 40);
  const ogImage = (await meta('meta[property="og:image"]')) ?? "";
  check("og:image is an absolute https URL", /^https:\/\/[^/]+\/assets\/og\.png$/.test(ogImage), ogImage);
  check("og:url and canonical", /^https:\/\/[^/]+\/$/.test((await meta('meta[property="og:url"]')) ?? ""));
  check("twitter:card", (await meta('meta[name="twitter:card"]')) === "summary_large_image");
  for (const asset of [
    "/assets/og.png",
    "/assets/favicon-32.png",
    "/assets/logo.svg",
    "/assets/apple-touch-icon.png",
  ]) {
    const r = await page.request.get(`${base}${asset}`);
    check(`${asset} is served`, r.ok(), String(r.status()));
  }

  // Links
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
  const bad = brokenLinks(hrefs, "index.html");
  check("home: every internal link and anchor has a target", bad.length === 0, bad.join(", "));
  const github = hrefs.filter((h) => h.startsWith("https://github.com/"));
  check(
    "home: GitHub links are the public repo or Sponsors",
    github.length > 0 && github.every((h) => h.startsWith(REPO) || h === SPONSOR_LINK),
    github.filter((h) => !h.startsWith(REPO)).join(", "),
  );
  const text = await page.locator("body").innerText();
  check("home: no $10 on the page", !text.includes("$10"));
  check("home: no Subscribe on the page", !/subscribe/i.test(text));

  // Images and Softies
  const brokenImgs = await page.$$eval("img", (imgs) =>
    imgs.filter((i) => i.loading !== "lazy" && !(i.complete && i.naturalWidth > 0)).map((i) => i.src),
  );
  check("home: every eager image loads", brokenImgs.length === 0, brokenImgs.join(", "));
  await page
    .locator(".team svg.av")
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  check("the six Softies in the hero go inline", (await page.locator(".team svg.av").count()) === 6);
  const svgIds = await page.$$eval("svg [id]", (els) => els.map((e) => e.id));
  check("inline Softies keep unique ids", new Set(svgIds).size === svgIds.length);
  const names = (await page.locator(".lineup b").allInnerTexts()).join(",");
  check("Meet the team lists the six Softies", names === "Yo,Dew,Pico,Mochi,Clove,Kiki", names);

  // Support Yo with the real config
  const sponsor = page.locator("#support [data-sponsor]");
  check("Sponsor monthly is visible", await sponsor.isVisible());
  check("Sponsor monthly goes to SPONSOR_LINK", (await sponsor.getAttribute("href")) === SPONSOR_LINK);
  check(
    "Chip in follows SUPPORT_ONCE_LINK",
    SUPPORT_ONCE_LINK
      ? (await page.locator("#support [data-support-once]").getAttribute("href")) === SUPPORT_ONCE_LINK
      : !(await page.locator("#support [data-support-once]").isVisible()),
  );
  const giveText = (await page.locator("#support").innerText()).replace(/\s+/g, " ");
  check(
    "Support Yo says it's free, optional and a gift",
    giveText.includes("Yo is free. It always will be.") &&
      giveText.includes("everything stays free either way") &&
      giveText.includes("isn't refundable") &&
      giveText.includes("tax-deductible"),
    giveText,
  );
  check(
    "real config: footer Contact mails support",
    (await page.locator("footer [data-support-email]").getAttribute("href")) ===
      "mailto:support@theyoapp.com",
  );

  // Model picker: open Pico's chip, pick Grok.
  const pico = page.locator('.picker-row[data-agent="Pico"]');
  await pico.locator("[data-chip]").click();
  check(
    "picker: Pico's chip opens its menu",
    (await pico.locator("[data-chip]").getAttribute("aria-expanded")) === "true",
  );
  check("picker: the menu names Pico", (await page.locator("[data-menu-agent]").innerText()) === "Pico");
  check(
    "picker: the menu sits under Pico's row",
    await page.evaluate(() =>
      document
        .querySelector('.picker-row[data-agent="Pico"]')
        .nextElementSibling?.hasAttribute("data-menu-panel"),
    ),
  );
  await page.locator(".opt", { hasText: "Grok" }).click();
  check(
    "picker: Pico's chip now says Grok",
    (await pico.locator("[data-chip-label]").innerText()) === "Grok",
  );
  check(
    "picker: a note says the agent kept its memory",
    /Pico now uses Grok\. Same name, same memory/.test(await page.locator("[data-picker-note]").innerText()),
  );
  await pico.locator("[data-chip]").click();
  check("picker: the chip closes the menu again", await page.locator("[data-menu-panel]").isHidden());

  // Take over Kiki's computer, then hand it back.
  const toggle = page.locator("[data-pc-toggle]");
  await toggle.click();
  check(
    "take over: you have control",
    (await page.locator("[data-pc-label]").innerText()) === "You have control" &&
      (await toggle.innerText()) === "Hand back" &&
      (await toggle.getAttribute("aria-pressed")) === "true",
  );
  await toggle.click();
  check(
    "hand back: Kiki has control again",
    (await page.locator("[data-pc-label]").innerText()) === "Kiki has control",
  );

  check(`${tag}: still no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

// ------------------------------------------------- Support Yo links from config.js
{
  const once = "https://buy.stripe.com/test_00abcDEF123";
  const { page, errors, context } = await open(1440, { config: { once, sponsor: SPONSOR_LINK } });
  const chip = page.locator("#support [data-support-once]");
  check("Chip in shows with a valid Payment Link", await chip.isVisible());
  check("Chip in points at SUPPORT_ONCE_LINK", (await chip.getAttribute("href")) === once);
  check("Chip in says Chip in", (await chip.innerText()).trim() === "Chip in");
  check("no console errors (chip in)", errors.length === 0, errors.join(" | "));
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
  const { page, context } = await open(1440, { config: { once: bad, sponsor: SPONSOR_LINK } });
  check(`Chip in stays hidden for ${bad}`, !(await page.locator("#support [data-support-once]").isVisible()));
  await context.close();
}
for (const bad of [
  "",
  "https://github.com/JuniorSua",
  "https://evil.example/sponsors/x",
  "javascript:alert(1)",
]) {
  const { page, context } = await open(1440, { config: { sponsor: bad } });
  check(
    `Sponsor monthly hides for ${JSON.stringify(bad)}`,
    !(await page.locator("#support [data-sponsor]").isVisible()),
  );
  await context.close();
}
{
  const { page, context } = await open(1440, { config: {} });
  check(
    "no Contact link while SUPPORT_EMAIL is empty",
    !(await page.locator("footer [data-support-email]").isVisible()),
  );
  await context.close();
}

// ------------------------------------------------- Download on a Mac
{
  const { page, errors, context, github } = await open(1440, { clipboard: true });
  const hero = page.locator(".hero-actions a[data-download]");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), hero.click()]);
  check("hero Download downloads the .dmg itself", download.url() === DMG, download.url());
  check("the page stays put", page.url().startsWith(base), page.url());
  const panel = page.getByRole("dialog", { name: "Your download has started" });
  check("next-steps panel appears", await panel.isVisible());
  check(
    "panel has the focus",
    await page.evaluate(() => document.activeElement?.hasAttribute("data-dl-panel")),
  );
  const panelText = (await panel.innerText()).replace(/\s+/g, " ");
  check("panel says nothing about paying", !/\$|subscribe|license|refund/i.test(panelText), panelText);
  const steps = (await panel.locator("[data-dl-mac] ol li").allInnerTexts()).map((t) =>
    t.replace(/\s+/g, " ").trim(),
  );
  check(
    "panel lists the 3 steps with the file's name",
    steps.length === 3 &&
      steps[0] === `Open “${DMG_NAME}” from your Downloads.` &&
      steps[1] === "Drag Yo into Applications." &&
      steps[2].startsWith("First open: macOS asks once."),
    JSON.stringify(steps),
  );
  check(
    "'Didn't start?' links to the .dmg",
    (await panel.getByRole("link", { name: "Download it here" }).getAttribute("href")) === DMG,
  );
  await panel.getByRole("button", { name: "Copy a setup prompt" }).click();
  check(
    "Copy a setup prompt copies exactly the prompt",
    (await page.evaluate(() => navigator.clipboard.readText())) === PROMPT,
  );
  check("… and says so", /Copied/.test(await panel.locator("[data-setup-note]").innerText()));
  check("GitHub's API asked only once (prefetched, then cached)", github.api === 1, String(github.api));
  check(
    "GitHub's API is the pinned release",
    github.apiUrls.length === 1 && github.apiUrls[0] === RELEASE_API,
    github.apiUrls.join(", "),
  );
  await page.keyboard.press("Escape");
  check("Escape closes the panel", !(await panel.isVisible()));
  check("focus goes back to Download", await hero.evaluate((a) => document.activeElement === a));
  await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }),
    page.locator(".nav-end a[data-download]").click(),
  ]);
  check("nav Download shows the panel too", await panel.isVisible());
  await panel.getByRole("link", { name: "Need help?" }).click();
  check("'Need help?' opens the first-open FAQ", await page.locator("#first-open").evaluate((d) => d.open));
  check("… and closes the panel", !(await panel.isVisible()));
  await Promise.all([page.waitForEvent("download", { timeout: 5000 }), hero.click()]);
  await panel.getByRole("button", { name: "Close" }).click();
  check("Close button closes the panel", !(await panel.isVisible()));
  check("each click downloaded the .dmg", github.dmg === 3, String(github.dmg));
  check("no console errors (download)", errors.length === 0, errors.join(" | "));
  await context.close();
}

// Copy without the clipboard API: the prompt shows selected in a field.
{
  const { page, errors, context } = await open(1440, {
    init: () => {
      Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
      document.execCommand = () => false;
    },
  });
  await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }),
    page.locator(".hero-actions a[data-download]").click(),
  ]);
  await page.getByRole("button", { name: "Copy a setup prompt" }).click();
  const fb = page.locator("[data-setup-fallback]");
  check("setup prompt fallback field appears", await fb.isVisible());
  check("fallback field holds the exact prompt", (await fb.inputValue()) === PROMPT);
  check("no console errors (prompt fallback)", errors.length === 0, errors.join(" | "));
  await context.close();
}

// ----------------------------- Download falls back to the release page
for (const api of ["fail", "nodmg"]) {
  const { page, context, github } = await open(1440, { api });
  await Promise.all([
    page.waitForURL(RELEASES, { timeout: 8000 }),
    page.locator(".hero-actions a[data-download]").click(),
  ]);
  check(`API ${api}: Download opens the release page`, page.url() === RELEASES, page.url());
  check(`API ${api}: nothing else downloaded`, github.dmg === 0);
  await context.close();
}

// -------------------------------------- Download on Windows and Linux
for (const os of ["windows", "linux"]) {
  const other = os === "windows" ? "linux" : "windows";
  const { page, errors, context, github } = await open(1440, { os, clipboard: true });
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.locator(".hero-actions a[data-download]").click();
  const panel = page.getByRole("dialog", { name: "Yo for Windows and Linux" });
  await panel.waitFor({ timeout: 3000 });
  check(`${os}: 'Yo for Windows and Linux' panel`, await panel.isVisible());
  const text = (await panel.innerText()).replace(/\s+/g, " ");
  check(`${os}: shows its install command`, await panel.getByText(INSTALL[os], { exact: true }).isVisible());
  check(
    `${os}: hides the ${other} command`,
    !(await panel.getByText(INSTALL[other], { exact: true }).isVisible()),
  );
  check(
    `${os}: says where to paste it`,
    os === "windows" ? text.includes("Open PowerShell: Start menu") : text.includes("Open a terminal."),
    text,
  );
  check(`${os}: says nothing about paying`, !/\$|subscribe|license|refund/i.test(text), text);
  check(
    `${os}: links to the full instructions`,
    (await panel.getByRole("link", { name: "Full instructions" }).getAttribute("href")) === PC_GUIDE,
  );
  const copy = panel.getByRole("button", {
    name: `Copy the ${os === "windows" ? "Windows" : "Linux"} command`,
  });
  await copy.click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(`${os}: Copy puts exactly the command on the clipboard`, clip === INSTALL[os], JSON.stringify(clip));
  check(`${os}: Copy says Copied`, (await copy.innerText()).trim() === "Copied");
  await page.waitForTimeout(400);
  check(`${os}: no download starts`, downloads === 0 && github.dmg === 0);
  await page.mouse.click(1300, 400);
  check(`${os}: a click outside closes the panel`, !(await panel.isVisible()));
  check(`no console errors (${os})`, errors.length === 0, errors.join(" | "));
  await context.close();
}

// ------------------------------------------------------------- Mobile 390
for (const scheme of ["light", "dark"]) {
  const { page, errors, context } = await open(390, { os: "iphone", height: 844, scheme });
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`mobile ${scheme}: no horizontal scroll at 390px`, (await overflow()) <= 0, `${await overflow()}px`);
  if (scheme === "light") {
    check(
      "mobile: hero Download is visible",
      await page.locator(".hero-actions a[data-download]").isVisible(),
    );
    check("mobile: the team stands on the app", await page.locator(".team").isVisible());
    await page.locator(".nav-menu").click();
    const menu = page.locator("[data-mobile-menu]");
    check("mobile menu opens", await menu.isVisible());
    check("mobile menu has Download", await menu.locator(`a[href="${RELEASES}"]`).isVisible());
    check("mobile menu has Support Yo", await menu.locator('a[href="#support"]').isVisible());
    await menu.locator("a[data-download]").click();
    const panel = page.getByRole("dialog", { name: "Yo for Windows and Linux" });
    await panel.waitFor({ timeout: 3000 });
    for (const os of ["windows", "linux"])
      check(
        `phone: shows the ${os} command`,
        await panel.getByText(INSTALL[os], { exact: true }).isVisible(),
      );
    const box = await panel.boundingBox();
    check(
      "phone: the panel is a bottom sheet that fits the screen",
      (await panel.evaluate((p) => p.classList.contains("is-sheet"))) &&
        box &&
        box.x >= 0 &&
        box.x + box.width <= 390 &&
        box.y >= 0 &&
        box.y + box.height <= 844,
      JSON.stringify(box),
    );
    check("no horizontal scroll with the panel open", (await overflow()) <= 0, `${await overflow()}px`);
  }
  check(`no console errors (mobile ${scheme})`, errors.length === 0, errors.join(" | "));
  await context.close();
}

// ------------------------------------------------- The other pages
for (const [name, heading] of [
  ["support", "How can we help?"],
  ["terms", "The deal, in plain words."],
  ["privacy", "Your data stays yours."],
  ["thanks", "Thank you for supporting Yo."],
  ["404", "Yo couldn't find that page."],
]) {
  for (const [width, scheme] of [
    [1440, "light"],
    [390, "dark"],
  ]) {
    const { page, errors, context } = await open(width, { scheme, path: `/${name}.html` });
    const tag = `${name} (${width} ${scheme})`;
    check(`${tag}: heading`, (await page.locator("h1").innerText()).trim() === heading);
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    const bad = brokenLinks(hrefs, `${name}.html`);
    check(`${tag}: every link has a target`, bad.length === 0, bad.join(", "));
    check(
      `${tag}: links home, help, privacy and terms`,
      ["/", "/support", "/privacy", "/terms"].every((h) => hrefs.includes(h)),
    );
    check(
      `${tag}: footer links to Support Yo`,
      (await page.locator('footer a[href="/#support"]').count()) === 1,
    );
    check(
      `${tag}: GitHub links are the public repo or Sponsors`,
      hrefs
        .filter((h) => h.startsWith("https://github.com/"))
        .every((h) => h.startsWith(REPO) || h === SPONSOR_LINK),
    );
    const text = await page.locator("body").innerText();
    check(`${tag}: no $10 or Subscribe`, !text.includes("$10") && !/subscribe/i.test(text));
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${tag}: no horizontal scroll`, over <= 0, `${over}px`);
    check(`${tag}: no console errors`, errors.length === 0, errors.join(" | "));
    await context.close();
  }
}

await browser.close();
console.log(`${passed.length} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
