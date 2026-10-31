# Yo in your browser: the PC edition (and the road to Yo Cloud)

Started 2026-10-18. Branch `feat/web-app`.

Yo has been a Mac app. This adds a **PC edition**: Yo's core and the agent's computer run on the user's own
Windows or Linux PC in Docker, and the user opens Yo in Chrome, Edge or Firefox at `http://127.0.0.1:7777`. It's the
same UI the Mac app shows (the Mac app is a window around this same page), so every feature that isn't tied to
macOS works the same way.

## What a PC user needs for the same experience

| Mac app | PC edition | How |
| --- | --- | --- |
| Download a .dmg, drag to Applications | One command in PowerShell (Windows) or a terminal (Linux) | `pc/install.ps1`, `pc/install.sh` |
| The app checks the Mac's RAM, CPU, disk and macOS, and lists the tools to install | The installer checks Windows/Linux, RAM, CPU, disk and Docker, and offers to install Docker Desktop (Windows, with `winget`) | installer preflight |
| Colima runs the agent's computer in a VM | Docker Desktop (Windows) or Docker Engine (Linux) runs the same two containers | `pc/compose.yaml` |
| The app icon in the Dock and Launchpad | A **Yo** shortcut in the Start menu and on the desktop (Windows); `yo-app open` (Linux). Chrome/Edge can also **Install Yo** as an app window | `yo-app open`, web manifest |
| The app signs in to core with a key in the Keychain | The browser keeps its own key (WebCrypto, can't be copied out) and signs in with a one-time link the installer opens | browser sign-in (below) |
| Sign in once; stays signed in | Same. The key stays in the browser; sessions renew by themselves, including after a restart | |
| Connect Claude or ChatGPT | Same screens. Claude: Claude Code's own sign-in on Yo's computer (Claude's page, then paste the code it shows; nothing to install or type). ChatGPT: Codex's own sign-in on Yo's computer (ChatGPT's page, then paste the address the browser lands on; or a one-time code once device code sign-in is on in ChatGPT's settings) | |
| Watch the computer live, Take over, terminal, files | Same (noVNC and the terminal go through core's WebSocket) | |
| Notifications | Browser notifications (allowed on `127.0.0.1`, which browsers treat as secure) and in-page toasts | |
| Menu bar: closing the window keeps agents running | Yo keeps running in Docker with the browser closed, and starts with Docker after a restart | `restart: unless-stopped` |
| Updates: the app offers Restart | `yo-app update` pulls the newest release; Settings → Updates says when one is out | |
| Uninstall: drag to Trash | `yo-app uninstall` (asks before deleting Yo's data) | |
| Support Yo (free and open source; optional Chip in and Sponsors) | Same Settings → Support Yo | |
| Mac-only: Calendar, Contacts, Reminders, Notes, Mail, window control, shared Mac folders | Not on PC. Settings says they need the Mac app | |
| Sign in another browser | Settings → **Browsers & apps** → Sign in another browser (one-time link + QR), or `yo-app signin` | |

## Requirements (PC)

- Windows 11, or Windows 10 22H2 (64-bit), with virtualization on; or a 64-bit Linux with Docker Engine.
- 16 GB of RAM recommended, 8 GB minimum (the agent's computer then gets 3 GB instead of 4.5 GB).
- 4 CPU cores recommended (2 minimum), 15 GB free disk.
- Docker Desktop (free for personal use and small businesses), or Docker Engine on Linux.
- A Claude Pro/Max or ChatGPT subscription, as on the Mac.

## How it fits together

```
 Browser (Chrome/Edge/Firefox) ──http://127.0.0.1:7777──▶ yo-core container ──ws──▶ yo-computer container
   key in IndexedDB                (published on 127.0.0.1 only)   UI + API + /ws       agentd, Chromium, noVNC
```

- `pc/compose.yaml`: two services on a private bridge network. Core publishes `127.0.0.1:${YO_PORT}` only (never
  the LAN), listens on the same port inside the container (so the browser's Origin matches), and reaches agentd at
  `http://yo-computer:7801`. agentd is not published at all.
- **Core refuses connections from the agent's computer** (`YO_DENY_PEERS=yo-computer`): it resolves that name and
  drops sockets from its addresses, so a prompt-injected agent can't even reach core's sign-in endpoints. On the
  Mac and the home server, core already listens on loopback where the computer can't reach it.
- Data lives in two named Docker volumes (`core-data`, `computer-data`), so there are no Windows path or permission
  problems. A one-shot `init` service makes `core-data` writable by core's user.
- `YO_EDITION=pc`, `YO_CORE_PLACEMENT=this-pc`, `YO_HELPER_COMMAND=yo-app` tell core (and through `/auth/info`, the
  UI) which wording and commands to show.

### Browser sign-in

Same controller model as the Mac app (`apps/core/src/auth/ControllerAuth.ts`), with the browser as the key holder:

1. The installer (or `yo-app signin`) writes a one-time token into core's data (`/data/enroll-token`, 10 minutes,
   works once) and opens `http://127.0.0.1:7777/#signin=<token>`. A signed-in browser can also make a link in
   Settings (`auth.signInLink.create`, kept in core's memory, same rules).
2. The page makes an Ed25519 key with WebCrypto (`extractable: false`), stores the CryptoKey in IndexedDB under the
   core's id, and POSTs the public key with the token to `/auth/enroll`. The fragment is removed from the address
   bar right away, so the token never stays in history.
3. For a session it asks `/auth/challenge`, signs it, and POSTs `/auth/session` with `cookie: true`. Core answers
   with an HttpOnly, SameSite=Strict `yo_session` cookie (12 hours). Page script never sees a session token.
4. Before connecting (and on every reconnect) the page asks `/auth/me`; when the session ended (core restarted, 12
   hours passed) it signs a new challenge without bothering the user. Every 6 hours it renews ahead of time.
5. Revoking a browser in Settings ends its sessions and closes its open sockets at once. A revoked or unknown key
   sends the page back to the sign-in screen, which explains `yo-app signin`.

Why keys and not a password: nothing to remember or leak, nothing for a page on another site to replay (the cookie
is SameSite=Strict and the key can't be exported), and it's the same model a cloud host needs.

## What's in this branch

1. **Core**: cookie sessions, `/auth/me`, `/auth/signout`, sign-in links, the `auth.clients.*` methods, closing a
   revoked client's sockets, `YO_DENY_PEERS`, `YO_EDITION`/`YO_HELPER_COMMAND`, the "This PC" placement, and
   edition-neutral license wording.
2. **Web**: the browser sign-in module and screen, session renewal in the API client, Settings → Browsers & apps,
   sign-in links that open in the user's own browser (not on the server), PC wording (Ctrl shortcuts, `yo-app`
   commands, Windows install hints), the web app manifest and icons.
3. **PC package** (`pc/`): `compose.yaml`, `install.ps1` + `install.sh`, the `yo-app` helper for Windows and Linux,
   and the release workflow attaching them to each GitHub release.
4. **Tests**: core unit tests for every auth path, mock e2e for the sign-in screen and settings, and a real-stack
   e2e (`e2e/pc/`) that installs the PC edition from scratch with the installer and drives it in a browser.

## Security review and known limits

An adversarial review of this branch (2026-10-18) found these, now fixed: Vite's dev port 5173 was trusted outside
`YO_DEV` (any page on it would have had the browser's session); a malformed cookie could crash core; links used
`localhost` (browsers may try `::1`, where another local user could listen) instead of `127.0.0.1`; sign-in codes
were visible in the browser's command line; one throttle for every sign-in let a flood of bad enrollments stop
signed-in browsers from renewing; a browser signing itself out could lose its answer; `yo-app update` deleted its
backups before the new version was healthy; uninstall removed the whole install folder. Each has a test.

Still true, by design or until it can be checked on the right machine:
- **Docker Desktop's way to the PC.** On Docker Desktop, containers can reach the PC's own published ports through
  a special address. `pc/compose.yaml` points the names (`host.docker.internal`) nowhere for the agent's computer,
  but the raw address still works, and core can't tell that connection from the browser's. What the agent could
  reach there is only the sign-in surface (256-bit one-time codes, Ed25519 keys, failure brakes); it never holds a
  session. To verify on a PC with Docker Desktop: `docker compose exec yo-computer node -e "fetch('http://host.docker.internal:7777/healthz').then(r=>console.log(r.status),e=>console.log('blocked'))"`.
  A stronger fix (an egress filter for the computer) is a follow-up.
- **Other people with an account on the same PC.** Yo is per-user: another local user can't sign in (they'd need a
  one-time code from your session or your Docker), but while Yo is stopped they could start their own program on
  port 7777. Browser cookies are also shared by every program on `127.0.0.1`. Fine for a personal PC; a shared PC
  should use separate Windows accounts and not run other local web servers.
- **Snap browsers** (Ubuntu's default Firefox) can't read the private sign-in page, so on those the helper hands
  the link to the browser directly (visible in the process list for a moment, works once, 10 minutes).
- A browser signed in at `localhost` and one at `127.0.0.1` are different sites to the browser: use the
  `127.0.0.1` link the helper opens.

## The long-term goal: Yo Cloud

The owner's plan is to partner with a virtual server company so people can run Yo on rented compute instead of
their own machine. The PC edition is the first step, because a cloud Yo is the same thing with the PC replaced by
a VM:

1. **Same two containers, one VM per customer.** Each customer gets a small VM (4 vCPU / 8 GB) from the partner,
   running `pc/compose.yaml`. One VM per customer keeps every agent's computer isolated from other customers,
   which matters more than squeezing several onto one host.
2. **Same browser client.** Nothing in the web UI assumes Electron any more after this branch. A cloud Yo is the
   same page at `https://<name>.theyoapp.com`.
3. **Same sign-in.** The browser-key model works over HTTPS unchanged. The cloud adds an account step in front:
   theyoapp.com provisions the VM and hands the browser its first
   one-time sign-in link, the same `#signin=` token the PC installer uses. Cookies get `Secure` behind TLS.
4. **What the cloud still needs** (not in this branch): a TLS front door per VM (Caddy, or the partner's load
   balancer); `YO_ALLOWED_ORIGINS` for the public origin; provisioning and teardown APIs on the partner; backups of
   the two volumes; managed updates (the provider pulls new images, like `yo-app update`); billing that includes
   compute; and a decision about model sign-in on shared infrastructure (each customer still brings their own
   Claude/ChatGPT plan, which stays the product's core idea).
5. **Partners to evaluate** for a free/cheap start and an API for provisioning: Hetzner Cloud, DigitalOcean,
   Vultr, Linode/Akamai, Fly.io Machines. The setup screen's "Cloud — coming soon" card is where it plugs in.

## Testing

- `pnpm check` (unit tests include every new auth path: cookie sessions, `/auth/me`, sign-out, sign-in links, the
  client list, revoking closes sockets, `YO_DENY_PEERS`, the release check, the browser key and signature) and
  `pnpm e2e` (mock UI: `e2e/tests/browser-signin.spec.ts` covers the sign-in screen, Browsers & apps, PC wording on
  Windows and Linux, and PC onboarding).
- **Real stack, no mocks:** `node e2e/pc/run.mjs` builds the core image from this checkout, installs it with
  `pc/install.sh` into a throwaway folder on a spare port and project, and drives it in Chromium and Firefox
  (`e2e/pc/pc.spec.ts`): the sign-in screen and a refused API call; the installer's link (pasted into an open tab);
  a used link failing; first-run onboarding with no Mac step; Claude's real sign-in link from Claude Code on
  Yo's computer (then canceled); one short Haiku chat on an API-key account when `YO_E2E_ANTHROPIC_API_KEY` is
  set; the live screen with real pixels, Take over, the terminal and files; signing in a second browser from
  Settings and signing it out (it drops to the sign-in screen and core answers 401); restarting core without losing
  the session or a draft; the agent's computer unable to reach core while it has the internet; `yo-app status`.
  Then `yo-app uninstall` and a check that no container or volume is left. Takes about 3 minutes after the build.
- **Windows:** `pc/install.ps1` and every `yo-app` command ran on Windows 11 in PowerShell 5.1 (against the Docker
  engine through a test-only `docker.cmd` shim, since this PC runs Docker in WSL, not Docker Desktop). The real
  installed **Edge 155** and **Chrome 155** on Windows were driven with Playwright: Windows wording on the sign-in
  screen, signing in with a `yo-app signin` link, staying signed in after closing and reopening the browser, the
  live screen, and Settings → Browsers & apps ("Edge on Windows").

### Not tested yet (needs a release or another machine)

- Installing Docker Desktop with `winget` and its first start (Docker Desktop isn't installed on the test PC).
- Pulling `ghcr.io/juniorsua/yo-core` from GitHub: today anonymous pulls of it are denied (it's private, or no
  release has pushed it yet; `yo-computer` is public). Before announcing the PC edition, check that the next
  release pushed it and make the package public (GitHub → Packages → yo-core → Package settings → Change
  visibility → Public). Until then the installer stops with a plain "couldn't download Yo" message.
- The release workflow attaching the PC files (checked locally: the YAML parses and the bake step runs).
- ARM64 PCs, and macOS with Docker Desktop.
