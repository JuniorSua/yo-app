# Yo

**Switch models, not apps.**

Yo is a free, open-source home for a team of AI agents, on the subscriptions you already have: Claude, ChatGPT
and Grok. Yo is the lead and your front door. Add teammates when you want them, give each one a job and the model
that suits it, and they work side by side on their own computer while you get on with your day. When a better
model comes out, you change a dropdown, not your app.

**So what are you selling me?** Nothing. Yo is free, and you can't pay us for AI. You bring the Claude, ChatGPT or
Grok plan you already pay for, sign in on that company's own page, and Yo drives their official tools (Claude
Code, Codex and the Grok CLI). Your prompts go from your computer straight to them, never through us, and your
agents' memory stays on your machine. Every line of Yo is public under Apache-2.0. If we ever go the wrong way,
fork it.

![Yo](https://theyoapp.com/assets/og.png)

**On Windows or Linux?** Yo runs there too, in your browser: see [Windows and Linux](#windows-and-linux-in-your-browser).

- [What Yo does](#what-yo-does)
- [Honest notes](#honest-notes)
- [What you need](#what-you-need)
- [Install](#install)
- [Windows and Linux (in your browser)](#windows-and-linux-in-your-browser)
- [Connect your model](#connect-your-model)
- [Yo sets up its computer](#yo-sets-up-its-computer)
- [Updates](#updates)
- [Getting help](#getting-help)
- [Uninstall](#uninstall)
- [Build it from source](#build-it-from-source)
- [Support Yo](#support-yo)
- [Contributing](#contributing)
- [License](#license)

## What Yo does

- **A team, not a chatbot.** Yo leads. Teammates are optional: one for research, one for building, one for your
  inbox, and so on. Each has a name, a job, its own memory and its own Softie, a small character in its own
  colour. They hand work to each other quietly ("Messaged Dew") and only come to you when something needs you.
- **Switch models, not apps.** Every agent runs on the subscription and model you pick for it, and you can change
  both from the chat header. An agent keeps its memory and history when it moves from Claude to ChatGPT or Grok.
- **Their own computer, on yours.** Your agents work in a private workspace: a Linux desktop with a real Chromium
  browser, a terminal and files, in a small virtual machine on your Mac (or on a PC at home). Watch it live, and
  **Take over** when a site wants a login or a 2FA code. It never touches your own browser or files unless you
  share them.
- **Asks before it acts.** Purchases, sending messages, posting and anything with a password wait for your OK.
- **Tasks.** What you asked for and what your agents said they'd do, on one list, so nothing quietly drops.
  Routines run on a schedule.
- **Pages.** Agents can make you a page (a chart, a dashboard, a plan) that you open, pin and download.
- **From your phone.** Text your agents, answer their questions and approve things with
  [Yo Phone](docs/phone/GUIDE.md), a web app you add to your Home Screen. Messages are end-to-end encrypted.
- **Telegram, if you like.** Chat, notifications and approvals through your own Telegram bot.
- **Work and Personal.** Two spaces with their own agents and memory, following your work hours.

## Honest notes

- **Bring your own computer.** Your agents' computer runs on your machine: a Mac with Apple silicon and 16 GB of
  memory or more (or a Windows or Linux PC, in the browser). There's no cloud option yet.
- **Your subscription's limits apply.** Yo uses your plan the same way Claude Code, Codex and the Grok CLI do. A team
  that works all day uses it faster than you would on your own.
- **One shared browser.** Each agent gets its own screen and windows, but they share one browser, so they all have
  the same logins.
- **Not notarized by Apple.** That takes a paid developer account, so macOS asks once before the first open (see
  [Install](#install)).
- **Small team.** Yo is built by one developer and a lot of AI agents. Expect rough edges, and please
  [report them](#getting-help).

## What you need

- **A Mac with Apple silicon** (M1 or newer). The download is built for Apple silicon only.
- **A Claude Pro/Max, ChatGPT or Grok (SuperGrok / X Premium) subscription.** Those are the three supported
  models.
- For the agent's computer on this Mac (the app checks each of these for you, in plain words, before it starts
  anything; the reasons and sources are in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)):

| | Minimum | Recommended |
| --- | --- | --- |
| Memory (RAM) | 16 GB | 32 GB |
| Memory for the agent's computer (what's left after 8 GB for macOS and your apps) | 2 GB | 4 GB |
| Processor | Apple silicon, 4 cores | 8 cores or more (every M-series chip has them) |
| Free disk space | 10 GB | 20 GB |
| macOS | 13 Ventura | 15 Sequoia or newer |
| Free tools | Included in the downloaded app (Colima, Lima, Docker CLI, Compose) | |

The agent's computer uses up to 4 CPUs, 5 GB of memory and a 20 GB disk, only while it's on. Quitting Yo
(⌘Q) stops it and gives the memory back.

## Install

**Set up with your agent.** If you use Claude Code or Codex, give it this one line and it installs Yo for you,
asking before it changes anything:

```text
Set up Yo for me. Follow the setup prompt at https://github.com/JuniorSua/yo-app/blob/main/SETUP_PROMPT.md
```

**Or by hand:**

1. On the [latest release](https://github.com/JuniorSua/yo-app/releases/latest), download the file ending in
   **.dmg** (Yo-&lt;version&gt;-arm64.dmg: that's the app; you can ignore the other files). Open it and drag
   **Yo** into **Applications**.
2. **The first open.** Yo is signed ad hoc, not notarized by Apple (that needs a paid Apple
   Developer ID), so macOS warns the first time ("Apple could not verify “Yo” is free of malware…").
   - **macOS 15 Sequoia and later:** open Yo and click **Done** on the warning. Then open
     **System Settings → Privacy & Security**, scroll down to "Yo was blocked…", click **Open Anyway**, then
     **Open Anyway** again and enter your Mac password. (Right-click → Open no longer skips the warning there.)
   - **macOS 13 or 14:** in Applications, **right-click Yo → Open**, then **Open** again.

   Or, on any version (and if macOS says Yo "is damaged"), run this once in Terminal, then open Yo normally:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Yo.app
   ```

**After an update**, macOS may ask whether Yo can use its confidential information stored in
**“Yo Safe Storage”** (Yo's saved login in your Keychain). Each ad-hoc signed version has a new signature, so
macOS checks once per update. Enter your Mac password and click **Always Allow**; Yo waits on a "Waiting for
macOS Keychain…" page until you do.

Yo lives in the menu bar: closing the window keeps Yo running. ⌘Q (or **Quit Yo** in the menu-bar icon) quits.

## Windows and Linux (in your browser)

On a Windows or Linux PC, Yo's core and its computer run in Docker on your PC, and you use Yo in Chrome, Edge or
Firefox at `http://127.0.0.1:7777`. It's the same Yo as on the Mac, without the Mac-only parts (Calendar, Contacts,
Reminders, Notes, Mail and controlling Mac windows).

**What you need:**

- Windows 11, or Windows 10 version 22H2 (64-bit); or a 64-bit Linux
- 8 GB of memory (RAM) at least, 16 GB recommended
- 4 processor cores recommended
- 15 GB of free disk space
- Docker Desktop on Windows (free for personal use; the installer offers to install it for you), or Docker Engine
  on Linux

**Install.** On Windows, open **PowerShell** (Start menu, type PowerShell, press Enter) and paste:

```powershell
irm https://github.com/JuniorSua/yo-app/releases/latest/download/install.ps1 | iex
```

On Linux (or Ubuntu on Windows' WSL), in a terminal:

```bash
curl -fsSL https://github.com/JuniorSua/yo-app/releases/latest/download/install.sh | bash
```

The installer checks your PC (each check in plain words), installs Docker if you agree, downloads Yo (about 1 GB),
starts it and opens it in your browser, signed in. On Windows it adds a **Yo** icon to the Start menu and the
desktop. Yo keeps running in the background with Docker, also with the browser closed. Running the same command
again repairs or updates Yo and keeps your data. Then [connect your model](#connect-your-model) as on the Mac
(Claude Code on Windows: `irm https://claude.ai/install.ps1 | iex`).

**The `yo-app` command** (in PowerShell, Command Prompt or a Linux terminal):

| Command | What it does |
| --- | --- |
| `yo-app open` | Open Yo in your browser (starts it if needed) |
| `yo-app signin` | A one-time sign-in link for another browser (works once, for 10 minutes) |
| `yo-app status` | Is Yo running? |
| `yo-app stop` / `start` / `restart` | Stop, start or restart Yo |
| `yo-app update` | Get the newest Yo (your data stays) |
| `yo-app logs` | Yo's recent messages, for bug reports |
| `yo-app uninstall` | Remove Yo (asks before deleting your data) |

## Connect your model

On first launch Yo walks you through connecting your plan. It first looks for a Claude Code or Codex sign-in
that's already on your Mac and offers to use the same plan. Otherwise pick one; each takes about two minutes, with
nothing to type in Terminal and a status that turns green when Yo sees the connection.

**Claude** (Pro or Max): no Terminal and nothing to install. Yo runs Claude Code in its private workspace, and you
sign in on Claude's own page, so Yo never sees your password. Your sign-in stays inside Yo's computer.

1. Press **Sign in to Claude**. Yo starts the sign-in on its computer (it starts the computer first if it's off).
2. Claude's sign-in page opens in your browser (or open the link Yo shows, even on your phone). Sign in with the
   account that has your plan and click **Authorize**.
3. Claude shows a code. Paste it into Yo and press **Connect**. Claude Code keeps the sign-in on Yo's computer.

On a new Mac, Yo's computer is set up first (in the first agent's chat), and the Claude sign-in comes right after.
Signed in to Claude with an older Yo (a pasted token)? It keeps working. Settings → Accounts asks you to sign in
once the new way; after that Yo deletes the old token.

**ChatGPT** (Plus, Pro, Business or Enterprise): no Terminal and nothing to install, the same on every edition.
Yo runs Codex in its private workspace, and you sign in to ChatGPT there with ChatGPT's own sign-in page. Yo never sees
your password. The Codex sign-in you may already use on your Mac keeps working; it's never copied.

1. Press **Sign in to ChatGPT**. Yo starts the sign-in on its computer (it starts the computer first if it's off).
2. ChatGPT's sign-in page opens in your browser (or open the link Yo shows, even on your phone). Sign in with the
   account that has your plan and click **Continue**.
3. Your browser then shows a page that says it can't connect (it starts with `http://127.0.0.1:1455`). That's
   expected. Copy the whole address from the address bar, paste it into Yo and press **Connect**. Codex keeps the
   sign-in on Yo's computer.

Rather use a one-time code? Press **Sign in with a one-time code instead**. ChatGPT only accepts codes once
you turn on "Enable device code authorization for Codex" in ChatGPT's settings, under Security (Yo has a button
that opens them; on a work or school account, your admin allows it). Then press **Get my code**, open the link,
enter the code, and Yo turns green by itself.

On a new Mac, Yo's computer is set up first (in the first agent's chat), and the ChatGPT sign-in comes right after.
Connected ChatGPT with an older Yo (the Terminal sign-in)? It keeps working.

**Grok** (SuperGrok or X Premium), nothing to type in Terminal. Grok signs in inside Yo's private workspace, so it needs
Colima and the Docker CLI first (see [Yo sets up its computer](#yo-sets-up-its-computer)), and the first time
takes a few minutes while that computer starts:

1. Press **Get my code**. Yo runs `grok login --device-auth` in its private workspace and shows a link and a code.
2. Open the link in any browser (your phone works too) and sign in with the X or Grok account that has your
   plan.
3. Check that the page shows the same code and approve. Yo turns green by itself.

An xAI API key works too (billed by xAI per use). Yo keeps this key in its secret storage (the Keychain on a Mac).

You can connect another one later in **Settings → Accounts**, and pick the account and model for Yo (and Pip)
from the model picker under the message box.

## Yo sets up its computer

Once a model is connected, Yo's chat opens with: *"Looks like we have a model connected. Let's set up my
computer."* (If Pip's chat opens instead, press ⌘⇧M to switch to Work.) It offers three places to run it:

- **This Mac** (free): the downloaded app already includes Colima, Lima, the Docker CLI and Compose, so a new
  Mac does not open Terminal or type an admin password. Yo checks this Mac against the requirements above
  (pass, warn or block, each in plain words). If this Mac already has a computer in `~/.colima`, Yo asks
  whether to keep it there or move it into Yo's folder. Nothing is deleted. Then it starts the computer and
  confirms it's live. The first start downloads the computer (about 1 GB) and takes a few minutes. A
  development build still shows the Homebrew commands (`brew install colima docker docker-compose`) when those
  tools are missing.
- **Home server** (advanced): Yo's core and the agent's computer run on your own always-on PC at home (Linux,
  or Windows with WSL 2), so Yo keeps working while your Mac sleeps. Yo walks you through it
  step by step; the Mac reaches the PC over SSH, and nothing is exposed to the internet.
- **Cloud**: coming soon.

## Updates

Yo checks GitHub Releases for a newer version (when it starts and every few hours; Settings → About has a
**Check for updates** button). When there is one, the update button (bottom left) says
**"Yo 2.0.N is available: Download"**, which downloads the new .dmg in your browser. Then:

1. **Quit Yo:** ⌘Q, or **Quit Yo** in its menu-bar icon (closing the window isn't enough: Yo keeps running in
   the menu bar, and macOS won't replace an app that's open).
2. Open the new .dmg and drag **Yo** into **Applications**. Choose **Replace**.
3. Open Yo. If macOS asks about **“Yo Safe Storage”**, enter your Mac password and click **Always Allow** (see
   above).

Your chats, Yo's memory and your settings stay. (Ad-hoc signed apps can't update themselves in place on macOS,
so Yo only points you at the download.)

**Windows and Linux:** run `yo-app update`.

## Getting help

- **Something broke?** Open **Settings → Bug reports → Report a problem**, or tell Yo "report this bug". You see
  exactly what's sent before you press Send: what happened, a few details about your Mac and Yo, and (only if you
  leave the box ticked) the last messages of the chat. Passwords, keys, emails, your home folder's name and
  private network addresses are removed first, and the report is encrypted so only the Yo team can read it. No
  GitHub account needed.
- **Prefer GitHub?** [Open an issue](https://github.com/JuniorSua/yo-app/issues/new/choose). Issues are public:
  leave out anything private.
- **Security problem?** Report it privately, see [SECURITY.md](SECURITY.md).

## Uninstall

Yo adds no login items or background services. To remove it completely:

1. **Quit Yo** (⌘Q, or **Quit Yo** in the menu-bar icon). That also stops its computer.
2. **Delete the agent's computer** (its VM, files and browser sign-ins).

   The downloaded app keeps that computer inside Yo's own folder. Step 4 removes it, along with chats and
   settings. If you chose **Keep it where it is** during setup, the computer is still in `~/.colima`. Quit Yo,
   then delete only that profile (other Colima profiles stay):

   ```bash
   colima delete --profile yo --data --force
   ```

   Homebrew's `colima` only sees `~/.colima`. The copy inside Yo's folder is removed with the folder in step 4.
3. **Drag Yo.app** from Applications to the Trash.
4. **Delete Yo's data** (chats, memory, settings, logs) and its separate ChatGPT sign-in:

   ```bash
   rm -rf ~/Library/Application\ Support/Yo ~/.yo
   ```

5. **Remove Yo's saved logins from the Keychain** (the model sign-ins Yo keeps, and "Yo Safe Storage"). If
   macOS asks for your password, that's the Keychain checking it's you:

   ```bash
   while security delete-generic-password -s Yo > /dev/null 2>&1; do :; done
   security delete-generic-password -s "Yo Safe Storage" > /dev/null
   ```

   (Or open **Keychain Access**, search for "Yo" and delete the items named "Yo: …" and "Yo Safe Storage".)
6. Optional: anything you allowed in **System Settings → Privacy & Security** (Files and Folders, Contacts,
   Calendars, Accessibility, Screen Recording…) can be switched off there. The Colima, Lima and Docker binaries
   that shipped inside Yo.app go away with the app. A Homebrew copy, if you installed one for a development
   build, is separate: `brew uninstall colima docker docker-compose`. Claude Code and Codex are separate too.

**Windows and Linux:** run `yo-app uninstall`. It asks before deleting Yo's data (chats, memories and the
computer's files).

**Home server:** on the server, stop Yo and delete its containers, data and images:

```bash
cd ~/yo/computer && docker compose -f compose.server.yaml down -v
docker image rm ghcr.io/juniorsua/yo-core ghcr.io/juniorsua/yo-computer
rm -rf ~/yo
```

## Build it from source

You need a Mac with Apple silicon, Node 22 (see `.nvmrc`), pnpm 9 (`corepack enable` picks the right version),
and Xcode's command line tools for the small Swift helper.

```bash
git clone https://github.com/JuniorSua/yo-app.git && cd yo-app
pnpm install
pnpm --filter @yo/core --filter @yo/web build
pnpm app:build                 # builds Yo.app and installs it in /Applications
```

A build from this repo follows the public releases for updates, and pulls the agent's computer for its version
from `ghcr.io/juniorsua/yo-computer`.

For working on Yo itself:

```bash
pnpm check                     # typecheck + lint + unit tests
pnpm e2e                       # Playwright UI tests against the in-browser mock backend
pnpm --filter @yo/web dev:mock # the UI alone, with the mock backend
pnpm dev                       # core (watch) + web (Vite) at http://127.0.0.1:5173
pnpm computer:build            # build the agent's computer image yourself (needs Docker)
```

How it fits together:

```
Yo.app (Electron) ── starts ─▶ yo-core (Node, SQLite, 127.0.0.1:7777) ◀── web UI (React)
                                   │  token-authed WebSocket, loopback only
                                   ▼
                   Colima VM ▶ yo-computer container (127.0.0.1:7801)
                               agentd ─ Claude Agent SDK / Codex app-server / Grok ACP (grok agent stdio)
                                      ─ per-agent desktop + headed Chromium + VNC
                                      ─ MCP tools: browser, desktop, Yo (memory, approvals, …)
```

- **The model's tools run inside the agent's computer**, so its shell and file tools act on that machine only.
- **Yo owns each agent's identity**, memory, scratchpad and history. That's what lets an agent move between
  Claude, ChatGPT and Grok and stay itself.
- **Nothing runs in anyone's cloud** except the model calls your own subscription makes (and the bug reports you
  choose to send, encrypted). Credentials stay in your macOS Keychain, Yo's data folder (encrypted with a
  Keychain key) and the agent's VM, never in logs. Claude's and ChatGPT's sign-ins are Claude Code's and Codex's
  own, kept on the agent's computer.

| Path | What |
| --- | --- |
| `apps/desktop` | Electron shell (and the Swift helper for Mac access) |
| `apps/core` | Control plane: agents, sessions, approvals, memory, routines, secrets |
| `apps/agentd` | Daemon inside the agent's computer: provider adapters, displays, VNC, terminal, files, MCP |
| `apps/web` | UI (React 19, Tailwind v4, zustand, noVNC, xterm) |
| `packages/contracts` | Shared protocol types and checks (UI ↔ core ↔ agentd) |
| `packages/avatar` | The Yo logo and the Softies |
| `computer/` | The agent's computer image |
| `pc/` | Yo for Windows and Linux (in the browser): installers and the `yo-app` helper |
| `phone/` | Yo Phone, the phone web app, and its relay |
| `site/` | The website |

## Support Yo

Yo is free and open source. It always will be. If Yo gives you back a little time, you can give a little back:
[chip in once](https://theyoapp.com/#support), or [sponsor monthly](https://github.com/sponsors/JuniorSua) on
GitHub. It's totally optional, and everything stays free either way. A star here, or telling a friend, helps just
as much.

Support goes to the people building Yo. It isn't a charity, so it's not tax-deductible.

## Contributing

Small, focused pull requests are welcome: a bug fix, a clearer message, a missing test. For a bigger feature,
please open a [feature request](https://github.com/JuniorSua/yo-app/issues/new/choose) first so we can talk it
through before you spend the time. Opening a PR doesn't mean it will be merged. How to set up, test and send a
change: [CONTRIBUTING.md](CONTRIBUTING.md). Security problems: [SECURITY.md](SECURITY.md), privately.

## License

Yo is open source under the [Apache License 2.0](LICENSE) (Apache-2.0). It builds on ideas and code patterns
from T3 Code (MIT), Rakazo (Apache-2.0) and noVNC (MPL-2.0); see [NOTICE](NOTICE).

Yo was a paid app for a few weeks in 2026. Since Yo 2 it's free again, and those paid plans have ended.
