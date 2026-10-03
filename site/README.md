# Yo website

A one-page site for Yo with a clickable demo of the app. It's plain static HTML, CSS, and JS, with no build
step and no dependencies.

- **Live:** https://yo-app-five.vercel.app (Vercel project `yo-app`). No custom domain yet.
- **Inspiration:** [rakazo.com](https://rakazo.com) and [bestuplist.com](https://bestuplist.com), for the idea of a
  clickable product demo on a marketing page. Round 2 (owner feedback: "too similar, innovate") gave it its own
  identity: a living mascot whose eyes follow the cursor, a "Yo, …" ask box that sends tasks into the demo, the demo
  framed as a Mac desktop with a menu-bar appearance switch, a "Things to try" checklist, a bento of animated
  explainers, an agent lineup that opens agents in the demo, and a privacy map.
- **Public launch (M6):** Rakazo-style download hero ("Download for macOS" → GitHub Releases, "View on GitHub", and
  the `$ Set up with your agent` copy chip), how it works, requirements (from `docs/REQUIREMENTS.md`), an
  open-source section with the optional $10, and a demo that starts with the real first run: connect your model,
  then the first agent's "Let's set up my computer" chat.

## Sections

Hero (Download for macOS, View on GitHub, the copy chip, first-open hint) → Claude / ChatGPT strip → 01 Demo →
02 How it works → 03 Why Yo → 04 Agents → 05 Requirements → 06 Privacy → 07 Open source ($10) → 08 FAQ → the
yellow "Yo, what's first?" panel → footer.

Links point at the public repo `https://github.com/JuniorSua/yo-app`: `/releases/latest` for downloads,
`/blob/main/SETUP_PROMPT.md` for the copy chip, and `#build-it-from-source` in its README.

**Copy rules.** The numbers in Requirements must match `docs/REQUIREMENTS.md` (and
`packages/contracts/src/setup.ts`). The commands in How it works and the demo must match
`packages/contracts/src/connect.ts` (`CONNECT_COMMANDS`). No personal data: no emails, Tailscale addresses or
`*.ts.net` names, home paths, or the owner's surname. Claude and ChatGPT only.

## Files

| File | What |
|---|---|
| `index.html` | All page sections and copy |
| `config.js` | Owner settings: `STRIPE_PAYMENT_LINK` (see below). Public, so never a Stripe key |
| `styles.css` | Page styles: hero and mascot, desk frame, bento, steps, crew, privacy map, FAQ, final panel |
| `demo.css` | The demo window (`.app`, `.a-*`), using Yo's own light and dark tokens from `apps/web/src/styles.css` |
| `demo.js` | The interactive demo: the first run (connect your model, then the setup chat), agents, scripted chats, approvals, take over and hand back, model switching, routines, appearance, the checklist, and `window.yoDemo` (`open(id)`, `ask(text)`) for the rest of the page |
| `site.js` | Reveal on scroll, nav, menu, the copy chip, the $10 button, mascot eyes and blinking, the typing "Yo, …" boxes, and the small animation loops |
| `assets/` | `logo.svg`, `avatars/*.svg` (exported from `packages/avatar` on one padded 112-unit canvas so nothing is cropped and every character shares a ground line), `og.png` (social preview, 1200x630, made by `scripts/export-og.mjs`), `apple-touch-icon.png` and `favicon-32.png` |
| `fonts/` | Geist and Geist Mono woff2, copied from `@fontsource-variable` |
| `scripts/export-art.tsx` | Re-exports the logo and avatars from `packages/avatar`. Not deployed |
| `scripts/smoke.mjs` | Playwright smoke test (links, copy chip, $10 button, 375px, the demo's first run, no personal data). Not deployed |
| `scripts/export-og.mjs` | Re-renders `assets/og.png` (the link preview) from the hero, and the PNG icons from `logo.svg`. Run it after changing the hero's words. Not deployed |
| `scripts/shots.mjs` | Full-page, per-section and state screenshots at 1280 and 375. Not deployed |

## Run locally

```bash
cd site && python3 -m http.server 4321   # then open http://localhost:4321
```

## Test

From the repo root, with `node_modules` installed (Playwright's Chromium comes with the e2e setup):

```bash
python3 -m http.server 5471 -d site &
node site/scripts/smoke.mjs http://localhost:5471
node site/scripts/shots.mjs http://localhost:5471 /tmp/site-shots   # optional screenshots
```

## The $10 button (`STRIPE_PAYMENT_LINK`)

"Yo is $10, to support its development and updates." The button uses a Stripe **Payment Link**: a hosted
checkout page, so the site needs no keys and no backend. The download itself stays free on GitHub.

1. In the Stripe dashboard, create a Payment Link for a $10 product ("Yo"). Copy its URL. It looks like
   `https://buy.stripe.com/aBc123XyZ`.
2. Put it in `site/config.js`:
   ```js
   const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/aBc123XyZ";
   ```
3. Deploy (below). The "Support Yo · $10" button appears in the Open source section.

While it's empty (the default), the button stays hidden and the page says "Payments coming soon" and that the app is
a free download for now. Only `https://buy.stripe.com/<id>` URLs are accepted; anything else is ignored and the
page behaves as if it were empty. **Never put a Stripe secret or publishable key in this folder**: it's all public.

## Link preview (`og.png`)

Messages, Slack and X show `assets/og.png` when someone shares the link. It's a picture of the hero, so after
changing the hero's words, re-render it (and the PNG icons) with the site served locally:

```bash
python3 -m http.server 5471 -d site &
node site/scripts/export-og.mjs http://localhost:5471
```

`og:image` in `index.html` is an absolute URL (previews need one). When the custom domain is added, change it
there to the new domain.

## Re-export the art (after avatar changes)

From the repo root, with `node_modules` installed:

```bash
npx tsx --tsconfig packages/avatar/tsconfig.json site/scripts/export-art.tsx site/assets
```

## Deploy

Deploys run from this folder with the Vercel CLI, which is already signed in as `juniorsua`:

```bash
cd site && npx vercel deploy --prod --yes
```

`.vercelignore` keeps `scripts/`, `README.md`, and `.env*` out of the upload. The Git repo isn't connected to Vercel
yet, so pushing to `main` does not deploy.

## Known gaps

- The demo's free-typed replies are canned and match on keywords. The demo says so after the first one. Its first
  run is scripted too: it doesn't check the visitor's Mac.
- Restaurant, store, bank, and product names in the demo are made up.
