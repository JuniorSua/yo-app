# Yo website

The one-page site for Yo 2, plus help, privacy, terms and a thank-you page. It's plain static HTML, CSS and JS,
with no build step and no dependencies.

- **Live:** https://theyoapp.com (custom domain on the Vercel project `yo-app`).
  https://yo-app-five.vercel.app still works. See [Custom domain](#custom-domain).
- **Yo 2 (2026-10-30):** "Switch models, not apps." Yo is free and open source (Apache-2.0), runs on the
  subscriptions people already have, and is a team of agents with their own computer. Support is optional.
  The look follows Dots: white and grey surfaces, ink text, and each Softie's colour tinting only its own world.
  There is **no pricing** anywhere: no $10 a month, no Subscribe, no licence keys. The smoke test enforces it.
- **Deploy only with the public release.** The site goes live after the owner says yes to it, together with the
  public source and the release.

## Sections

Hero ("Switch models, not apps.", Download, View on GitHub, the six Softies standing on a drawing of the app) →
Meet the team (Yo, Dew, Pico, Mochi, Clove, Kiki and their jobs) → Bring your own subscription (each agent on
its own model; the picker is clickable) → Its own computer (Kiki's computer in Kiki's wallpaper; Take over is
clickable) → On your phone too (labelled Coming soon) → Open source ("So what are we selling you? Nothing.") →
Support Yo (`#support`: Chip in, Sponsor monthly) → FAQ → closing Download.

Other pages: `/support` (help for Yo for Mac, Windows and Linux, the iPhone app; a note for people on old versions
that asked for a licence key; a pointer to Support Yo), `/privacy`, `/terms`, `/thanks` (where Stripe sends people
after Chip in) and `404.html`. `/support` and `/privacy` are also the App Store's Support and Privacy Policy URLs,
so keep their iPhone sections.

**Copy rules.**
- Requirements in the FAQ must match `docs/REQUIREMENTS.md`: Apple silicon (M1 or newer), macOS 13 or newer,
  16 GB of memory (32 GB is better), about 20 GB free.
- Windows and Linux numbers and install commands (the Download panel on a PC, the FAQ and
  `/support#windows-linux`) must match "Windows and Linux (in your browser)" in the public README
  (JuniorSua/yo-app) and `pc/README.md`.
- Describe only what ships. Yo Phone and the iPhone app stay labelled Coming soon until they're open to everyone.
- Say "subscription" for Claude, ChatGPT and Grok plans. Never call Yo an "open-source Grok Bot" or name
  competitors.
- No personal data: no emails besides the support address, Tailscale addresses or `*.ts.net` names, home paths.
  The owner's own name appears only in the Terms, as the provider (his approved exception).
- The drawing of the app and Kiki's computer use made-up content. Real screenshots can replace the app drawing:
  put them at `site/img/app-*.png`.

## Files

| File | What |
|---|---|
| `index.html` | All home-page sections and copy, the drawing of the app, and the Download panel |
| `config.js` | Owner settings: `SUPPORT_EMAIL`, `DOWNLOAD_TAG`, `SUPPORT_ONCE_LINK` and `SPONSOR_LINK` (below). Public, so never a Stripe key |
| `contact.js` | On every page: fills in the support email, shows Chip in only for a valid `SUPPORT_ONCE_LINK`, and applies `SPONSOR_LINK` |
| `site.js` | Nav and menu, the Download panel (the .dmg on a Mac, the install command with Copy on Windows and Linux, both on phones), Copy a setup prompt, the Softies (inline, blinking, eyes that follow the pointer), the model picker and Take over |
| `styles.css` | Every page's styles, light and dark (`prefers-color-scheme`) |
| `support.html`, `privacy.html`, `terms.html`, `thanks.html`, `404.html` | The other pages |
| `assets/softies/` | The six Softies as static SVGs: `<id>.svg` (large) and `<id>-xs.svg` (small, simpler). Exported from the Softies design sources (Yo 2 avatar direction A); re-export them from `packages/avatar` once it ships the Softies, keeping the class names (`av-blink`, `av-gaze`, `av-shadow`) and the `--av-sh` contact-shadow variables |
| `assets/` | `logo.svg` (the speech-bubble logo), `wordmark.svg` and `brand-lockup*` (brand files, see `docs/brand/LOGO.md`), `og.png` (link preview, 1200x630), `apple-touch-icon.png`, `favicon-32.png` |
| `fonts/` | Geist and Geist Mono woff2 |
| `api/` | The old licence endpoints. **Kept on purpose, but nothing links to them**: 0.1.x installs still call `/api/license/check` every day, and `apps/core/test/licenseEmail.test.ts` imports `api/_lib`. Remove them only after those versions are gone (and delete that test with them) |
| `scripts/smoke.mjs` | Playwright smoke test (below). Not deployed |
| `scripts/shots.mjs` | Screenshots in light and dark: first screen and full page at 1440 and 390, each home section, and the other pages. Not deployed |
| `scripts/export-og.mjs` | Re-renders `assets/og.png` from the hero headline and the Softies, and the PNG icons from `logo.svg`. Not deployed |
| `scripts/export-art.tsx` | Re-exports `assets/logo.svg` from `packages/avatar`. Not deployed |
| `scripts/set-domain.mjs` | Switches every absolute URL on the site to a new domain in one command. Not deployed |

## Run locally and test

Run these on the PC (not the laptop), from the repo root, with `node_modules` installed:

```bash
python3 -m http.server 5190 -d site &        # or: npx -y serve -l 5190 site
node site/scripts/smoke.mjs http://localhost:5190
node site/scripts/shots.mjs http://localhost:5190 /tmp/site-shots   # optional screenshots
```

The smoke test checks the hero and its buttons, meta and link-preview tags, that every Download link and install
line follows `DOWNLOAD_TAG`, the Download panel on a Mac (mocked .dmg), Windows, Linux and phones, Support Yo
(Sponsor monthly, and Chip in only for a valid link), no "$10", "Subscribe" or licence-key wording on any page,
every internal link and anchor on every page, the model picker and Take over, no horizontal scroll at 390px in
light and dark, no console errors and no personal data.

## Download pin (`DOWNLOAD_TAG`)

Download buttons and the Windows and Linux install lines follow `DOWNLOAD_TAG` in `config.js` (a tag, or empty for
`/releases/latest`). The plain `href`s repeat that tag so they work with JavaScript off. To move the pin: change
`DOWNLOAD_TAG` in `site/config.js`, then put the same tag in the plain links in `site/index.html`,
`site/support.html` and `site/thanks.html` (Download hrefs, and `install.ps1` / `install.sh`). The smoke test reads
`DOWNLOAD_TAG` and checks every one. On a Mac, the button finds the release's `-arm64.dmg` through GitHub's API.

## Support Yo (`SUPPORT_ONCE_LINK`, `SPONSOR_LINK`)

Two buttons, both optional for the visitor. Support is a gift: it unlocks nothing, isn't refundable and isn't
tax-deductible (Terms §7).

- **Chip in** uses a Stripe **Payment Link** with "Customers choose what to pay" (one-time; for example a $5
  suggestion and a $1 minimum). In its settings, under **After payment**, redirect to `https://theyoapp.com/thanks`.
  Put the link in `SUPPORT_ONCE_LINK` in `site/config.js`. While it's empty, every Chip in button stays hidden.
  Only `https://buy.stripe.com/<id>` and `https://donate.stripe.com/<id>` links are accepted. Chip in needs
  JavaScript (its plain HTML starts hidden).
- **Sponsor monthly** goes to GitHub Sponsors, `SPONSOR_LINK` (`https://github.com/sponsors/JuniorSua`). The plain
  hrefs in `index.html` and `thanks.html` repeat it; the smoke test compares them. Set up the Sponsors profile
  before the site goes live, or the link shows GitHub's "not found" page.

**Never put a Stripe secret or publishable key in this folder**: it's all public.

## The support email (`SUPPORT_EMAIL`)

It's `support@theyoapp.com`. To change it, edit `site/config.js` and deploy. A Contact link appears in the footer and
"Email us" lines appear on the help and thank-you pages. While it's empty, those lines stay hidden and the pages
point to the in-app Report a problem and GitHub issues instead.

## Link preview (`og.png`)

Messages, Slack and X show `assets/og.png` when someone shares the link. After changing the hero's words,
re-render it (and the PNG icons) with the site served locally:

```bash
node site/scripts/export-og.mjs http://localhost:5190
```

`og:image`, `og:url` and the canonical links are absolute URLs (previews need them).

## Custom domain

The site's only absolute URLs are the link-preview image and canonical links in the `.html` files; every other link
is relative. To move to another domain once it's connected to the Vercel project `yo-app`:

```bash
node site/scripts/set-domain.mjs https://your-domain   # rewrites every page, then lists what's left
```

Then serve and smoke-test the site, deploy, and change the old address outside `site/`: the website link in
`README.md`, the App Store listing files, App Store Connect's Support / Marketing / Privacy Policy URLs, and the
Chip in Payment Link's after-payment redirect. `yo-phone.vercel.app` is a different project (the Yo Phone relay)
and must not change.

## Deploy

Only with the public release (see the top). Deploys run from this folder with the Vercel CLI, which is signed in
as `juniorsua`:

```bash
cd site && npx vercel deploy --prod --yes
```

`.vercelignore` keeps `scripts/`, `README.md` and `.env*` out of the upload. The Git repo isn't connected to Vercel,
so pushing to `main` does not deploy.
