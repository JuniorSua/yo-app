# Set up Yo with a coding agent

This file is written for a coding agent (Claude Code, Codex or similar) that a person has asked to install Yo
for them, with a line like:

```text
Set up Yo for me. Follow the setup prompt at https://github.com/JuniorSua/yo-app/blob/main/SETUP_PROMPT.md
```

Yo is a macOS app for a personal AI assistant (Yo, plus Pip for personal time). It works on its own computer (a
Linux desktop with Chromium, running in a small Colima VM), and runs on the Claude, ChatGPT or Grok plan the
person already pays for. Below are the steps, in order. Every command here is the one the Yo app itself shows;
don't substitute your own.

## How to work

Work like a careful onboarding engineer: do the steps yourself, explain only decisions and blockers, and verify
the result rather than stopping after the download.

Safety rules:

- **Never print, log, store or commit a secret.** That includes anything in `~/.codex` or `~/.claude`, the
  Keychain, any code a sign-in page shows, and the address ChatGPT's sign-in leads to. Never read those files.
- **Sign-ins stay under the person's control.** Claude's and ChatGPT's sign-ins happen inside Yo (on Claude's and
  ChatGPT's own pages); the person does them themselves. Commands that ask for the Mac's password (the Homebrew
  installer) are run by the person in their own Terminal window. Tell them exactly what to paste and wait for
  them.
- **Ask before** removing the quarantine flag, replacing an existing Yo.app, installing anything, or stopping
  any app, VM or container. Never stop or delete other Colima profiles or Docker containers.
- Don't start Colima yourself. Yo creates and starts its own VM (profile `yo`) when the person presses
  **Start my computer** in the app (or **Get my code** for Grok, which signs in on that computer).
- Every step below is **macOS only**. If you aren't on a Mac (`uname -s` isn't `Darwin`), stop and say so.

## 1. Ask first

Before changing anything, ask these short questions (offer the defaults):

1. **Which model?** Claude (a Pro or Max plan, through Claude Code), ChatGPT (a Plus, Pro, Business or
   Enterprise plan, through Codex) or Grok (SuperGrok or X Premium, through the Grok CLI). Those are the three.
2. **Where should the agent's computer run?**
   - **This Mac** (default, free): in a small VM on this Mac.
   - **Home server** (advanced): an always-on PC at home (Linux, or Windows with WSL 2), reached over SSH.
     Yo still gets installed on this Mac; the server part is done afterwards, in Yo's setup chat.
   - **Cloud** is coming soon. It isn't available yet.
3. **Yo is $10 a month.** Say so up front: Yo asks for a license key (from a subscription on theyoapp.com) when
   it first opens. Downloading and installing is fine before they subscribe.
4. **Where to install Yo?** `/Applications` (default) or `~/Applications`. Call it `<install dir>` below.

## 2. Preflight (macOS)

Run these and report the results in one short table. They are the same checks, with the same thresholds, that
Yo's own requirements check uses.

```bash
sw_vers -productVersion                    # macOS version
sysctl -n hw.optional.arm64                # 1 = Apple silicon (an error or 0 = Intel)
sysctl -n machdep.cpu.brand_string         # the chip
sysctl -n hw.physicalcpu                   # physical cores
sysctl -n hw.memsize                       # memory in bytes (divide by 1073741824 for GB)
df -k "$HOME" | awk 'NR==2 {printf "%.0f GB free\n", $4/1048576}'
```

| Check | Block (stop) | Warn (works, say why) | Pass |
| --- | --- | --- | --- |
| Memory | under 16 GB | 16 GB to under 32 GB | 32 GB or more |
| Memory for the agent's computer (memory minus 8 GB, at most 4.5 GB) | under 2 GB | 2 to under 4 GB | 4 GB or more |
| Processor | fewer than 4 cores | Apple silicon with fewer than 8 cores | Apple silicon, 8+ cores |
| Free disk space | under 10 GB | 10 to under 20 GB | 20 GB or more |
| macOS | older than 13 (Ventura) | 13 or 14 | 15 (Sequoia) or newer |

**Intel Macs:** the Yo download is built for Apple silicon only, so stop and tell the person it won't run
there yet. For a **home server**, the memory, core and disk numbers apply to the server (16 GB minimum,
32 GB recommended, 4+ cores, about 20 GB free); this Mac only needs to run the app.

The downloaded Yo.app includes Colima, Lima, the Docker CLI and Compose for Apple silicon. A new Mac does not
need Homebrew for them. Still look, in case this is a development build or the tools failed to ship:

```bash
# Inside a built Yo.app these exist and are what the app runs:
ls "<install dir>/Yo.app/Contents/Resources/bin"
# Colima, the Docker CLI and Compose. A development build looks in Homebrew instead.
```

Colima and the Docker CLI are only needed when the computer runs on **this Mac**.

## 3. Download Yo

Find the newest release's Apple silicon zip and download it (public GitHub API, no sign-in needed):

```bash
URL=$(curl -fsSL https://api.github.com/repos/JuniorSua/yo-app/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*-arm64\.zip"' | cut -d'"' -f4)
echo "$URL"
curl -fL -o ~/Downloads/Yo-arm64.zip "$URL"
```

The same files are on https://github.com/JuniorSua/yo-app/releases/latest (`Yo-<version>-arm64.dmg` and
`.zip`). If `<install dir>/Yo.app` already exists, ask before replacing it, and quit Yo first
(`osascript -e 'tell application "Yo" to quit'`). Then unpack it:

```bash
mkdir -p "<install dir>"
ditto -x -k ~/Downloads/Yo-arm64.zip "<install dir>"
ls "<install dir>/Yo.app"
```

**The first open.** Yo is signed ad hoc, not notarized by Apple (there's no paid Apple Developer ID), so macOS
may refuse to open it the first time. A file downloaded with `curl` usually isn't marked as quarantined; check:

```bash
xattr -p com.apple.quarantine "<install dir>/Yo.app" 2>/dev/null && echo quarantined || echo "not quarantined"
```

If it's quarantined, explain the two options and let the person choose:

- By hand. On **macOS 15 Sequoia and later**: open Yo and click **Done** on the warning, then
  **System Settings → Privacy & Security**, scroll to "Yo was blocked…", click **Open Anyway**, then
  **Open Anyway** again and enter the Mac password (right-click → Open no longer skips the warning there).
  On **macOS 13 or 14**: in Finder, **right-click Yo → Open**, then **Open** again. Or
- with their OK, run: `xattr -dr com.apple.quarantine "<install dir>/Yo.app"`

Only run `xattr` after the person says yes.

**Keychain prompt.** A fresh install doesn't ask. After a later manual update, macOS may ask whether Yo can use
its confidential information stored in **"Yo Safe Storage"** (Yo's saved login in the Keychain; each ad-hoc
signed version has a new signature). Tell the person this is expected: enter the Mac password and click
**Always Allow**. Yo shows "Waiting for macOS Keychain…" until they answer.

## 4. Colima and the Docker CLI (this Mac only)

Skip this for a home server. The downloaded Yo.app already includes pinned Apple silicon builds of Colima,
Lima, the Docker CLI and Docker Compose, and it keeps their files under
`~/Library/Application Support/Yo` (`colima/`, `lima/` and `docker/`). A new Mac does not run Homebrew and does
not type an admin password for this.

If this Mac already has a computer in `~/.colima`, Yo's setup chat asks whether to **keep it where it is** or
**move it into Yo**. Neither choice deletes it. Other Colima profiles stay in `~/.colima`.

Run the steps below only when the preflight says the tools are missing (a development build, or an Intel Mac
built from source). These are the commands Yo's setup chat shows; all are free.

1. **Homebrew**, only if it's missing. Its installer asks for the Mac's password, so the person runs it in their
   own Terminal:

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

   On Apple silicon, put it on the PATH of the current shell afterwards:

   ```bash
   eval "$(/opt/homebrew/bin/brew shellenv)"
   ```

2. **Colima, the Docker CLI and Compose** (you can run this one; it takes a few minutes):

   ```bash
   brew install colima docker docker-compose
   ```

3. **Let Docker find the Compose plugin** (Homebrew's `docker-compose` is a Docker CLI plugin):

   ```bash
   mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
   ```

Check with `colima version`, `docker --version` and `docker compose version`. Docker Desktop is not needed.

## 5. Open Yo and connect the model

Open Yo (`open "<install dir>/Yo.app"`). First it shows **Activate Yo**: Yo is $10 a month. The person clicks
**Subscribe**, pays on theyoapp.com, copies the license key shown after paying, pastes it and clicks **Activate**
(you never see or handle the key, and never pay for them). Already subscribed: they paste their key. Lost it:
https://theyoapp.com/support#license-key. Then tell them what they'll see next: Yo's **Connect your model**
walkthrough. It first lists the sign-ins it can see on this Mac. A Claude Code or Codex sign-in only takes them to the
right steps below: they still sign in to Claude or ChatGPT on Yo's computer.

**Claude.** Nothing to install or type: Yo runs Claude Code on its own computer, and the person signs in on
Claude's own page. In the walkthrough they press **Sign in to Claude**, sign in with the account that has their
plan, click **Authorize**, and paste the code Claude shows into Yo. Yo never sees their password, and neither do
you. Their sign-in stays inside Yo's computer. Don't ask for the code.

Claude signs in on Yo's computer, so on a Mac that hasn't set it up yet the walkthrough says so: they press
**Continue**, set up the computer in the first agent's chat (step 6), and sign in to Claude at the end of it.

**ChatGPT.** Nothing to install or type either: Yo runs Codex on its own computer, and the person signs in to
ChatGPT there with ChatGPT's own sign-in page. They don't need Codex on this Mac. In the walkthrough they press
**Sign in to ChatGPT**, sign in on ChatGPT's page with the account that has their plan and click **Continue**.
Their browser then lands on a page that says it can't connect (the address starts with `http://127.0.0.1:1455`).
That's expected: they copy the whole address from the address bar and paste it into Yo. Don't ask for that address
(it carries a one-time sign-in code). As with Claude, on a Mac that hasn't set up Yo's computer yet, they press
**Continue** and sign in at the end of the setup chat (step 6).

If copying the address is hard for them, Yo offers **Sign in with a one-time code instead**. ChatGPT only accepts
codes after they turn on "Enable device code authorization for Codex" in ChatGPT's settings, under Security (Yo
has a button that opens them; on a work or school account, their admin allows it). Then they press **Get my
code**, open the link and enter the code; Yo turns green by itself.

**Grok.** Nothing to type in Terminal: Grok signs in on Yo's own computer, so do step 4 (Colima and the
Docker CLI) first. The person presses **Get my code** in Yo's walkthrough (the first time, Yo starts its
computer, which takes a few minutes), opens the link it shows in any browser, signs in with the X or Grok
account that has their plan, checks the code matches and approves. Yo turns green by itself. Don't open the
link or approve the code for them.

## 6. Start the agent's computer

Yo's chat opens with "Looks like we have a model connected. Let's set up my computer." (or, when they chose
Claude or ChatGPT, "Let's set up my computer first. You sign in to Claude on it right after.", with ChatGPT in
place of Claude when they chose it) and three cards. (Outside the person's work hours the app may open Pip, the Personal space, instead;
press ⌘⇧M to switch to Work, where Yo's setup chat is.)

- **This Mac:** the person picks it. Yo checks the Mac (the same table as the preflight), shows any missing
  tools with copy buttons (already installed in step 4), and offers **Start my computer**. The first start
  creates Yo's VM (4 CPUs, 5 GB memory, 20 GB disk) and downloads the agent's computer (about 1 GB, plus a few
  hundred MB for the VM itself). Allow a few minutes. If they chose Claude, the chat then shows **Sign in to
  Claude** (Claude's own page, then the code it shows); if they chose ChatGPT, **Sign in to ChatGPT** (ChatGPT's
  own page, then the address the browser lands on). **Start chatting** comes after that.
- **Home server:** the person picks it, and Yo's setup chat shows each step with the exact commands: build and
  start Yo on the server with `computer/compose.server.yaml`, check SSH from this Mac, point this Mac's Yo at
  the server, and open an SSH tunnel. Help them run the steps in that order, on the machine each one says.
  Never forward ports 7777 or 7801 on a router: the SSH tunnel is the only way in. They connect the model again
  in the server's Yo afterwards.
- **Cloud:** coming soon (the card is disabled).

## 7. Verify

Report each of these as passed or failed:

1. **Yo opens:** `pgrep -x Yo` prints a process id and the Yo window shows.
2. **Core is healthy** (this Mac, or the tunnel for a home server):

   ```bash
   curl -s http://127.0.0.1:7777/healthz        # prints: ok
   ```

3. **The model is connected:** Yo's walkthrough showed the green "connected" status, and
   **Settings → Accounts** lists the account as connected.
4. **The agent's computer is live** (this Mac):

   ```bash
   # The downloaded app. If the person chose "Keep it where it is", use ~/.colima and ~/.colima/_lima instead.
   export COLIMA_HOME="$HOME/Library/Application Support/Yo/colima"
   export LIMA_HOME="$HOME/Library/Application Support/Yo/lima"
   export DOCKER_CONFIG="$HOME/Library/Application Support/Yo/docker"
   colima status --profile yo
   docker --context colima-yo ps --filter name=yo-computer --format '{{.Names}}: {{.Status}}'
   ```

   Colima says it's running and the container (named like `yo-yo-computer-1`) is `Up`. In Yo, press
   **Watch screen** at the top right (or ⌘.): the screen pane says **Live**.
   Then ask the person to send the agent a harmless first message (for example "Open example.com and tell me
   its title") and confirm it answers.

When finished, report: the install path and Yo's version (**Settings → About**), the macOS version and chip,
the preflight results, which model is connected (never a key or code), where the computer runs, the four checks
above, and anything left to do.

## Troubleshooting

- **"Yo is damaged and can't be opened" / "cannot be opened because the developer cannot be verified":** the
  quarantine flag from a browser download. Use **Open Anyway** in System Settings → Privacy & Security
  (macOS 15+; right-click → Open on macOS 13 or 14), or (with the person's OK)
  `xattr -dr com.apple.quarantine "<install dir>/Yo.app"`. For "is damaged", only `xattr` helps.
- **macOS asks about "Yo Safe Storage" / Yo says "Waiting for macOS Keychain…":** expected after an update.
  Enter the Mac password and click **Always Allow** (not Deny), and Yo continues.
- **Yo opens, but the window stays blank or says core didn't start:** quit Yo (⌘Q) and open it again. If it
  persists, look at the end of `~/Library/Application Support/Yo/logs/core.log` and report the error lines
  (check them for anything secret before sharing).
- **`curl .../healthz` fails:** Yo isn't running, or (home server) the SSH tunnel is down. Open Yo, or restart
  the tunnel: `ssh -N -L 7777:127.0.0.1:7777 <you>@<your-server>`.
- **Claude doesn't accept the code:** codes expire quickly and only work with the newest sign-in link. Press
  **Try again** in Yo for a fresh link, sign in, and paste the whole code Claude shows.
- **ChatGPT says "That isn't the address Yo needs" or "cut short":** after clicking **Continue** on ChatGPT's
  page, copy the whole address of the page that says it can't connect (click the address bar, select all, copy),
  not the sign-in link. "From an earlier sign-in": press **Try again** and use the newest page.
- **ChatGPT's code page says code sign-in is off (or to ask an admin):** turn on "Enable device code authorization
  for Codex" in ChatGPT's settings → Security, then enter the same code again; or use ChatGPT's sign-in page
  instead (no setting needed).
- **"Colima/Docker CLI not installed":** the downloaded app includes them. Reinstall Yo.app, then press
  **Check again**. For a development build, run step 4. Yo also looks in `/opt/homebrew/bin` and `/usr/local/bin`.
- **`docker compose version` fails:** the app links Compose into its own Docker config
  (`~/Library/Application Support/Yo/docker`). For a development build, run the plugin link command from step 4.
- **The computer fails to start:** Yo shows the error in the setup chat. With the `COLIMA_HOME` / `LIMA_HOME` /
  `DOCKER_CONFIG` lines from the verify step, `colima status --profile yo` and `colima list` help explain it
  (often not enough free memory or disk). Free some up and press **Try again**. Ask before deleting anything;
  never touch other Colima profiles.
- **Yo found an existing computer in ~/.colima:** the person picks **Keep it where it is** or **Move it into Yo**
  in the setup chat. Neither deletes it. Do not remove `~/.colima` for them.
- **An Intel Mac:** the download is Apple silicon only for now.
- **Starting over with the computer** (ask first: it deletes the agent's computer, including the files and
  browser sign-ins on it; Yo's chats and memory stay): quit Yo. If they kept `~/.colima`, run
  `colima delete --profile yo --data --force`. If the computer lives in Yo's folder, run the same command with
  the `COLIMA_HOME`, `LIMA_HOME` and `DOCKER_CONFIG` lines from the verify step (without `--data` the computer's
  files and sign-ins survive). Then open Yo again. A Grok sign-in lives on that computer, so Grok needs
  **Get my code** once more.
- **Removing Yo completely:** follow "Uninstall" in [README.md](README.md#uninstall), asking before each step.
