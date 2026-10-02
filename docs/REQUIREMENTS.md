# What Yo needs to run (requirements)

Written once here, kept in code once in [`packages/contracts/src/setup.ts`](../packages/contracts/src/setup.ts)
(`REQUIREMENTS`, `LOCAL_COMPUTER`, `SETUP_COMMANDS`). The app's requirement check (core, the web UI and its mock)
reads them from there. The website, the README and `SETUP_PROMPT.md` must quote these numbers and commands, not
their own. If one changes, change `setup.ts` and this page together.

## This Mac (the agent's computer runs locally)

Yo runs its agent's computer (a Linux desktop with Chromium and a terminal) in a container, inside a small
virtual machine that [Colima](https://github.com/abiosoft/colima) starts with Apple's Virtualization framework
(`--vm-type vz`). Today Yo gives that VM **4 CPUs, 5 GB of memory and a 20 GB disk**, and the container a
**4.5 GB** memory limit (`ComputerLifecycle.ts`, `computer/compose*.yaml`).

| Check | Block (can't run) | Warn (works, with a caveat) | Pass |
| --- | --- | --- | --- |
| **Memory (RAM)** | under 16 GB | 16 GB up to 32 GB | **32 GB or more (recommended)** |
| **Memory for the agent's computer** | under 2 GB to spare | 2-4 GB | **4 GB or more (recommended)** |
| **Processor** | fewer than 4 cores | Intel (any), or Apple silicon with fewer than 8 cores | **Apple silicon (M1 or newer), 8+ cores** |
| **Free disk space** | under 10 GB | 10-20 GB | **20 GB or more** |
| **macOS** | older than 13 (Ventura) | 13 or 14 | **15 (Sequoia) or newer** |
| Couldn't check | never blocks | shown as "Couldn't check" | |

**Memory: 16 GB minimum, 32 GB recommended.** The VM takes up to 5 GB while it's on. macOS, Yo itself and the
user's own apps keep about 8 GB for themselves (`hostReserveGB`), which leaves the agent's computer what it needs
on a 16 GB Mac, and nothing on an 8 GB one. 32 GB leaves the user's own apps plenty of room while an agent works.

**Memory for the agent's computer: 4 GB recommended, 2 GB minimum.** Measured as the Mac's memory minus the 8 GB
reserve, capped at the container's 4.5 GB limit. Chromium with a few tabs, a desktop and a terminal fit in 4 GB;
under 2 GB, Chromium alone runs out of memory.

**Processor: Apple silicon recommended, Intel supported but slower.**
- Yo's VM uses 4 CPUs, so fewer than 4 physical cores can't keep up (block).
- Apple silicon runs the arm64 image natively. Every M-series chip has at least 8 cores, so any M1 or newer passes.
- Intel Macs work (the computer image is published for amd64 too, and the VM then runs x86_64) but are slower,
  and Homebrew treats Intel as a Tier 3 platform: it no longer builds ready-made packages for Intel, so
  installing the Docker CLI there builds it from source. Homebrew plans to drop Intel in or after September 2027.
- Core reads `hw.optional.arm64`, which is 1 on Apple silicon even when core runs under Rosetta, and physical
  (not hyperthreaded) cores from `hw.physicalcpu`.

**Free disk: about 20 GB.** The computer image is about 0.9 GB to download and about 3 GB unpacked (measured on
`yo-computer` builds: 810 MB content, 2.94 GB on disk). Colima's VM disk is sparse and grows as it's used, up
to the 20 GB Yo gives it. 10 GB is enough to download, unpack and start (block below that); 20 GB lets the
VM disk fill without filling the Mac. App updates download the new image before the old one is removed.

**macOS: 13 (Ventura) or newer, 15 or newer recommended.**
- Colima's `vz` VM type needs macOS 13 or newer (Lima's vz driver requires macOS 13; Intel Macs on macOS
  before 13.5 can fail to boot some Linux kernels).
- Homebrew only ships ready-made Colima packages for macOS 14+ and Docker CLI packages for macOS 15+ on Apple
  silicon. On older versions, `brew install` builds from source, which is slow and can fail.

### Free tools the check looks for

| Tool | How it's detected | Install (copy-paste, all free) |
| --- | --- | --- |
| Homebrew | `brew --version` | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`, then on Apple silicon `eval "$(/opt/homebrew/bin/brew shellenv)"` |
| Colima | `colima version` | `brew install colima docker docker-compose` |
| Docker CLI | `docker --version` | (same command) |
| Docker Compose plugin | `docker compose version` | `mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose` |

Homebrew is only asked for when something else is missing. Homebrew's `docker-compose` formula is a Docker CLI
plugin: its caveat says Docker won't find it until it's linked into a plugin folder, which the last command does
(Docker looks in `~/.docker/cli-plugins` by default).

Core runs these with Homebrew's folders on the PATH (a Finder-launched app doesn't inherit the shell's PATH).
Every probe is best effort: a missing `sw_vers`, `sysctl` or `colima` gives "unknown" or "not installed", never
an error.

## Home server (advanced)

Yo's core and the agent's computer both run on an always-on PC at home (Linux, or Windows with WSL 2), and the
Mac app opens Yo there through an SSH tunnel. The same memory, CPU and disk numbers apply to that PC (16 GB
minimum, 32 GB recommended; 4+ cores; about 20 GB free). It also needs Docker Engine with the Compose plugin,
git and Node 22, and SSH access from the Mac. The step-by-step guide is in the setup chat
(`apps/web/src/components/setup/homeServer.ts`), using `computer/compose.server.yaml`. Never forward Yo's ports
(7777, 7801) on a router.

## Cloud

Coming soon. No requirements yet.

## Sources

- Lima, `vz` VM type (macOS 13+; the Intel before-13.5 kernel issue): https://lima-vm.io/docs/config/vmtype/vz/
- Colima README (vz, Rosetta needs macOS 13 on Apple silicon; `brew install colima`; Docker client via
  `brew install docker`): https://github.com/abiosoft/colima
- Homebrew installation (Apple silicon, macOS 15+ for Tier 1; the install command): https://docs.brew.sh/Installation
- Homebrew support tiers (Intel x86_64 is Tier 3; Intel support ends in or after September 2027):
  https://docs.brew.sh/Support-Tiers
- Homebrew formula data (bottles: `colima` for arm64 Sonoma+ and Intel Sonoma; `docker` for arm64 Sequoia+;
  `docker-compose` caveat about `cliPluginsExtraDirs`):
  https://formulae.brew.sh/formula/colima, https://formulae.brew.sh/formula/docker,
  https://formulae.brew.sh/formula/docker-compose
- Image size: `docker image ls` of `yo-computer` builds (2.94 GB on disk, 810 MB content), 2026-10-02.
