# Set up Yo with a coding agent

This file is written for a coding agent (Claude Code, Codex or similar) that a person has asked to install Yo
for them, with a line like:

```text
Set up Yo for me. Follow the setup prompt at https://github.com/JuniorSua/yo-app/blob/main/SETUP_PROMPT.md
```

Yo is a macOS app for personal AI agents. Each agent works on its own computer (a Linux desktop with Chromium,
running in a small Colima VM), and runs on the Claude or ChatGPT plan the person already pays for. Below are
the steps, in order. Every command here is the one the Yo app itself shows; don't substitute your own.

## How to work

Work like a careful onboarding engineer: do the steps yourself, explain only decisions and blockers, and verify
the result rather than stopping after the download.

Safety rules:

- **Never print, log, store or commit a secret.** That includes the Claude sign-in token, anything in
  `~/.yo/codex`, `~/.codex` or `~/.claude`, and the Keychain. Never read those files. The person pastes the
  Claude token into Yo themselves; you never see it.
- **Sign-ins stay under the person's control.** Commands that open a browser to sign in (`claude setup-token`,
  `codex login`) or ask for the Mac's password (the Homebrew installer) are run by the person in their own
  Terminal window. Tell them exactly what to paste and wait for them.
- **Ask before** removing the quarantine flag, replacing an existing Yo.app, installing anything, or stopping
  any app, VM or container. Never stop or delete other Colima profiles or Docker containers.
- Don't start Colima yourself. Yo creates and starts its own VM (profile `yo`) when the person presses
  **Start my computer** in the app.
- Every step below is **macOS only**. If you aren't on a Mac (`uname -s` isn't `Darwin`), stop and say so.

## 1. Ask first

Before changing anything, ask these short questions (offer the defaults):

1. **Which model?** Claude (a Pro or Max plan, through Claude Code) or ChatGPT (a Plus/Pro plan, through
   Codex). Those are the only two.
2. **Where should the agent's computer run?**
   - **This Mac** (default, free): in a small VM on this Mac.
   - **Home server** (advanced): an always-on PC at home (Linux, or Windows with WSL 2), reached over SSH.
     Yo still gets installed on this Mac; the server part is done afterwards, in Yo's setup chat.
   - **Cloud** is coming soon. It isn't available yet.
3. **Where to install Yo?** `/Applications` (default) or `~/Applications`. Call it `<install dir>` below.

## 2. Preflight (macOS)

Run these and report the results in one short table. They are the same checks, with the same thresholds, that
Yo's own requirements check uses ([docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)).

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

Then look for the free tools. A Mac app doesn't see your shell's PATH, but Yo adds Homebrew's folders itself;
if `brew` isn't found, also try `/opt/homebrew/bin/brew --version`.

```bash
brew --version              # Homebrew
colima version              # Colima
docker --version            # Docker CLI
docker compose version      # Docker Compose plugin
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

- In Finder: **right-click Yo → Open**, then **Open** again (on macOS 15 and later: open it once, then
  **System Settings → Privacy & Security → Open Anyway**), or
- with their OK, run: `xattr -dr com.apple.quarantine "<install dir>/Yo.app"`

Only run `xattr` after the person says yes.

## 4. Install Colima and the Docker CLI (this Mac only)

Skip this for a home server, and skip any tool the preflight already found. These are the commands Yo's setup
chat shows; all are free.

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

Open Yo (`open "<install dir>/Yo.app"`) and tell the person what they'll see: Yo's **Connect your model**
walkthrough. It first looks for a Claude Code or Codex sign-in already on this Mac and offers to use it. If it
finds one, they can pick it and skip the rest of this step.

**Claude.** If `claude --version` fails, install Claude Code (you can run this):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Then the person runs this **in their own Terminal** (not through you), signs in in the browser with the
account that has their plan, and pastes the token Terminal prints (it starts with `sk-ant-oat`) into step 3 of
Yo's walkthrough, then presses **Connect**:

```bash
claude setup-token
```

Don't run `claude setup-token` yourself and don't ask for the token: it goes straight from their Terminal into
Yo, which keeps it in its secret store.

**ChatGPT (Codex).** If `codex --version` fails, install Codex (you can run this; the second command is the
Homebrew alternative when there's no npm):

```bash
npm install -g @openai/codex
brew install --cask codex
```

Then the person runs this **in their own Terminal** and signs in with ChatGPT in the browser. It's a separate
sign-in, kept in its own folder just for Yo, so their usual Codex sign-in keeps working:

```bash
mkdir -p ~/.yo/codex && CODEX_HOME=~/.yo/codex codex login
```

Yo notices the sign-in by itself and turns green. You can confirm without reading any file:
`CODEX_HOME=~/.yo/codex codex login status` (it says whether it's logged in, not the credentials).

## 6. Start the agent's computer

Once the model is connected, the first agent opens with "Looks like we have a model connected. Let's set up my
computer." and three cards:

- **This Mac:** the person picks it. Yo checks the Mac (the same table as the preflight), shows any missing
  tools with copy buttons (already installed in step 4), and offers **Start my computer**. The first start
  creates Yo's VM (4 CPUs, 5 GB memory, 20 GB disk) and downloads the agent's computer (about 1 GB). Allow a
  few minutes.
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
   **Settings → Accounts** lists the account as connected. For ChatGPT, `CODEX_HOME=~/.yo/codex codex login status`
   also says it's logged in.
4. **The agent's computer is live** (this Mac):

   ```bash
   colima status --profile yo
   docker --context colima-yo ps --filter name=yo-computer --format '{{.Names}}: {{.Status}}'
   ```

   Colima says it's running and the container is `Up`. In Yo, the right pane shows the computer as **Live**.
   Then ask the person to send the agent a harmless first message (for example "Open example.com and tell me
   its title") and confirm it answers.

When finished, report: the install path and Yo's version (**Settings → About**), the macOS version and chip,
the preflight results, which model is connected (never the token), where the computer runs, the four checks
above, and anything left to do.

## Troubleshooting

- **"Yo is damaged and can't be opened" / "cannot be opened because the developer cannot be verified":** the
  quarantine flag from a browser download. Use right-click → Open, or (with the person's OK)
  `xattr -dr com.apple.quarantine "<install dir>/Yo.app"`.
- **Yo opens, but the window stays blank or says core didn't start:** quit Yo (⌘Q) and open it again. If it
  persists, look at the end of `~/Library/Application Support/Yo/logs/core.log` and report the error lines
  (check them for anything secret before sharing).
- **`curl .../healthz` fails:** Yo isn't running, or (home server) the SSH tunnel is down. Open Yo, or restart
  the tunnel: `ssh -N -L 7777:127.0.0.1:7777 <you>@<your-server>`.
- **The Claude token is refused:** copy the *whole* line that starts with `sk-ant-oat` (Terminal may wrap it)
  and paste it again. A key starting `sk-ant-api` is an API key, not a plan sign-in: run `claude setup-token`
  again.
- **ChatGPT stays "waiting for the sign-in":** make sure the login ran with `CODEX_HOME=~/.yo/codex` (the full
  command above) and finished in the browser, then press **Check again** in Yo.
- **"Colima/Docker CLI not installed":** run step 4, then press **Check again** in the setup chat. Yo adds
  `/opt/homebrew/bin` and `/usr/local/bin` to its PATH, so a fresh Terminal isn't needed.
- **`docker compose version` fails:** run the plugin link command from step 4 again.
- **The computer fails to start:** Yo shows the error in the setup chat; `colima status --profile yo` and
  `colima list` help explain it (often not enough free memory or disk). Free some up and press
  **Start my computer** again. Ask before deleting anything; never touch other Colima profiles.
- **An Intel Mac:** the download is Apple silicon only for now.
- **Starting over with the computer** (ask first: it deletes the agent's computer, including the files and
  browser sign-ins on it; Yo's agents, chats and memory stay): quit Yo, run `colima delete --profile yo`, and
  open Yo again.
