#!/usr/bin/env bash
# Installs Yo (PC edition) on Linux, including Ubuntu on Windows' WSL:
#   curl -fsSL https://github.com/JuniorSua/yo-app/releases/latest/download/install.sh | bash
#
# Checks this PC (64-bit, Linux, memory, processor, disk, Docker), offers to install Docker Engine, downloads Yo's
# compose.yaml and the yo-app helper from the release this script came with into ~/.local/share/yo-app, writes a
# private .env, downloads the images, starts Yo and opens it in the browser with a one-time sign-in link.
# Running it again on an installed PC repairs or updates Yo and keeps its data, secret and sign-ins.
#
# The release workflow bakes its version into BAKED_VERSION below. Overrides (tests, advanced):
#   YO_APP_HOME  YO_APP_BIN_DIR  YO_APP_PORT  YO_APP_PROJECT  YO_APP_VERSION  YO_APP_SOURCE (a folder with the
#   assets instead of downloading them)  YO_APP_RELEASES  YO_CORE_IMAGE  YO_COMPUTER_IMAGE  YO_APP_SKIP_PULL=1
#   YO_APP_NO_BROWSER=1  YO_APP_YES=1        (pc/README.md)
# Everything runs inside main(), so a download cut short runs nothing.
set -uo pipefail

main() {
  local BAKED_VERSION="__YO_VERSION__"
  local REPO="JuniorSua/yo-app"
  local RELEASES="${YO_APP_RELEASES:-https://github.com/$REPO/releases/download}"
  local API_LATEST="https://api.github.com/repos/$REPO/releases/latest"
  local CORE_REPO="ghcr.io/juniorsua/yo-core" COMPUTER_REPO="ghcr.io/juniorsua/yo-computer"
  local INSTALL_CMD="curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash"

  say() { printf '%s\n' "$*"; }
  pass() { printf '  OK     %s\n' "$*"; }
  note() { printf '  NOTE   %s\n' "$*"; }
  block() {
    printf '  STOP   %s\n' "$*"
    BLOCKED=1
  }
  die() {
    printf '\n%s\n' "$@" >&2
    exit 1
  }
  has_tty() { { : </dev/tty; } 2>/dev/null; }
  ask() {
    local q="$1" def="${2:-Y}" hint ans
    if [ "$def" = Y ]; then hint="[Y/n]"; else hint="[y/N]"; fi
    if [ "${YO_APP_YES:-}" = 1 ]; then
      say "$q $hint yes"
      return 0
    fi
    if ! has_tty; then
      [ "$def" = Y ]
      return
    fi
    printf '%s %s ' "$q" "$hint" >/dev/tty
    read -r ans </dev/tty || ans=""
    case "$ans" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) [ "$def" = Y ] ;;
    esac
  }
  is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }
  valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.+-]*)?$ ]]; }
  docker_state() { # 0 running, 1 not installed, 2 no permission, 3 not running
    command -v docker >/dev/null 2>&1 || return 1
    local out
    out="$(docker info --format '{{.ServerVersion}}' 2>&1)" && return 0
    case "$out" in *"ermission denied"*) return 2 ;; esac
    return 3
  }
  wait_docker() {
    local i=0
    while [ "$i" -lt "$1" ]; do
      docker_state && return 0
      sleep 3
      i=$((i + 3))
    done
    return 1
  }
  port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

  local BLOCKED=0
  local APP_HOME="${YO_APP_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/yo-app}"
  local BIN_DIR="${YO_APP_BIN_DIR:-$HOME/.local/bin}"
  local ENV_FILE="$APP_HOME/.env"
  local existing=0
  [ -f "$ENV_FILE" ] && existing=1
  env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
  env_set() {
    local tmp="$ENV_FILE.tmp.$$"
    (
      umask 077
      if [ -f "$ENV_FILE" ]; then
        awk -v k="$1" -v v="$2" 'BEGIN { done = 0 } index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' "$ENV_FILE" >"$tmp"
      else
        printf '# Yo (PC edition) settings, written by the installer. Keep this file private: YO_AGENTD_TOKEN is the\n# secret between Yo'"'"'s core and its computer.\n%s=%s\n' "$1" "$2" >"$tmp"
      fi
    ) && chmod 600 "$tmp" && mv -f "$tmp" "$ENV_FILE"
  }

  say ""
  say "Yo for Linux: installing Yo (PC edition)"
  say "========================================="
  if [ "$existing" = 1 ]; then
    say "Yo is already installed in $APP_HOME. This repairs or updates it; your chats, files and sign-ins stay."
  fi

  # ---------------------------------------------------------------- which version
  local VERSION="${YO_APP_VERSION:-}"
  if [ -z "$VERSION" ] && valid_version "$BAKED_VERSION"; then VERSION="$BAKED_VERSION"; fi
  if [ -z "$VERSION" ] && [ -n "${YO_APP_SOURCE:-}" ]; then VERSION="dev"; fi
  if [ -z "$VERSION" ]; then
    command -v curl >/dev/null 2>&1 || die "This installer needs curl. Install it (Ubuntu/Debian: sudo apt install curl) and run it again."
    VERSION="$(curl -fsSL -m 20 -H 'Accept: application/vnd.github+json' "$API_LATEST" 2>/dev/null |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$VERSION" ] || die "Couldn't ask GitHub for the newest version of Yo. Check this PC's internet connection and run the installer again."
    valid_version "$VERSION" || die "GitHub's answer about the newest version of Yo doesn't look like a version number, so nothing was installed." \
      "Try again in a few minutes; if it keeps happening, report it at https://github.com/$REPO/issues"
  fi
  # The version goes into download addresses and image names: the same check as 'yo-app update'.
  valid_version "$VERSION" || [ -n "${YO_APP_SOURCE:-}" ] || die "'$VERSION' doesn't look like a Yo version (like 0.1.700)."
  say "Version: $VERSION"

  # ---------------------------------------------------------------- this PC
  say ""
  say "Checking this PC:"
  local arch os mem_kb mem_gb cores memory_limit="4500m"
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) pass "64-bit processor (Intel/AMD)" ;;
    aarch64 | arm64) pass "64-bit processor (ARM)" ;;
    *) block "Yo needs a 64-bit Intel/AMD or ARM processor; this one is '$arch'." ;;
  esac
  os="$(uname -s)"
  if [ "$os" = Linux ]; then
    local pretty=""
    [ -r /etc/os-release ] && pretty="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"')"
    if is_wsl; then pass "Linux (${pretty:-Linux}) on Windows (WSL)"; else pass "Linux (${pretty:-Linux})"; fi
    mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)"
  elif [ "$os" = Darwin ]; then
    note "macOS: Yo has a Mac app (theyoapp.com). This browser edition works too, with Docker Desktop."
    mem_kb="$(($(sysctl -n hw.memsize) / 1024))"
  else
    block "Yo's PC edition runs on Linux and Windows; this system is '$os'."
    mem_kb=0
  fi
  mem_gb="$(awk -v k="${mem_kb:-0}" 'BEGIN { printf "%.0f", k / 1048576 }')"
  # A "16 GB" PC reports a little less than 16 GiB.
  if [ "${mem_kb:-0}" -lt 7340032 ]; then
    block "Yo needs at least 8 GB of memory (RAM); this PC has about $mem_gb GB."
  elif [ "$mem_kb" -lt 15204352 ]; then
    note "Memory: about $mem_gb GB. Yo works, but 16 GB is recommended; its computer gets 3 GB instead of 4.5 GB."
    memory_limit="3g"
  else
    pass "Memory: about $mem_gb GB"
  fi
  cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"
  if [ "$cores" -lt 2 ]; then
    block "Yo needs at least 2 processor cores; this PC has $cores."
  elif [ "$cores" -lt 4 ]; then
    note "Processor: $cores cores. Yo works, but 4 or more are recommended (it may feel slow while it works)."
  else
    pass "Processor: $cores cores"
  fi
  if command -v curl >/dev/null 2>&1; then
    pass "curl is installed"
  else
    block "Yo's installer needs curl. Install it (Ubuntu/Debian: sudo apt install curl)."
  fi
  if [ "$BLOCKED" = 1 ]; then
    die "Yo can't be installed on this PC yet: see the STOP lines above."
  fi

  # ---------------------------------------------------------------- Docker
  docker_state
  local ds=$?
  if [ "$ds" = 1 ]; then
    say ""
    say "Yo runs in Docker, which isn't installed yet. Docker Engine is free. Docker's official installer is:"
    say "    curl -fsSL https://get.docker.com | sudo sh"
    say "    sudo usermod -aG docker \"\$USER\"     (lets you use Docker without sudo)"
    if is_wsl; then
      say "(On Windows you can instead use Docker Desktop: turn on Settings > Resources > WSL integration for this"
      say " Linux, then run this installer again.)"
    fi
    if ask "Run these now? They need your password." Y; then
      curl -fsSL https://get.docker.com | sudo sh || die "Docker's installer stopped (the messages above say why). Fix that, then run Yo's installer again."
      sudo usermod -aG docker "$USER" || true
      if command -v systemctl >/dev/null 2>&1; then sudo systemctl enable --now docker >/dev/null 2>&1 || true; fi
    else
      die "Install Docker with the commands above, then run Yo's installer again:" "    $INSTALL_CMD"
    fi
    docker_state
    ds=$?
  fi
  if [ "$ds" = 2 ]; then
    if ! id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      say ""
      say "You don't have permission to use Docker yet: your user needs to be in the 'docker' group."
      if ask "Add $USER to the docker group now? (needs your password)" Y; then
        sudo usermod -aG docker "$USER" || true
      fi
    fi
    die "Docker works for you after you log out and back in (or open a new terminal and run: newgrp docker)." \
      "Then run the same command again; it continues where it stopped:" "    $INSTALL_CMD"
  fi
  if [ "$ds" = 3 ]; then
    say ""
    say "Docker is installed but isn't running."
    if command -v systemctl >/dev/null 2>&1 && systemctl cat docker.service >/dev/null 2>&1; then
      if ask "Start it now (and with this PC from now on)? It needs your password." Y; then
        sudo systemctl enable --now docker || true
      fi
    elif command -v service >/dev/null 2>&1 && [ -e /etc/init.d/docker ]; then
      if ask "Start it now? It needs your password." Y; then sudo service docker start || true; fi
    elif is_wsl; then
      say "Open Docker Desktop on Windows; waiting for it (up to 10 minutes)..."
    fi
    wait_docker 600 || die "Docker still isn't running. Start it (sudo systemctl start docker, or open Docker Desktop), then run the installer again."
    docker_state
    ds=$?
    [ "$ds" = 0 ] || die "Docker is running but you can't use it yet: log out and back in, then run the installer again."
  fi
  pass "Docker $(docker info --format '{{.ServerVersion}}' 2>/dev/null) is running"
  if [ "$(docker info --format '{{.OSType}}' 2>/dev/null)" != linux ]; then
    die "Docker is set to Windows containers. Switch Docker Desktop to Linux containers (its menu: Switch to Linux containers), then run the installer again."
  fi
  local cv
  cv="$(docker compose version --short 2>/dev/null)"
  cv="${cv#v}"
  if [ -n "$cv" ] && [ "${cv%%.*}" -ge 2 ] 2>/dev/null; then
    pass "Docker Compose $cv"
  else
    block "Yo needs Docker Compose version 2 or newer (the 'docker compose' command). Install the plugin: sudo apt install docker-compose-plugin"
  fi

  local root free_kb free_gb
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
  root="${root:-/var/lib/docker}"
  while [ ! -e "$root" ] && [ "$root" != / ]; do root="$(dirname "$root")"; done
  free_kb="$(df -Pk "$root" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  free_gb="$(awk -v k="${free_kb:-0}" 'BEGIN { printf "%.0f", k / 1048576 }')"
  if [ -z "$free_kb" ]; then
    note "Couldn't check free disk space. Yo needs about 15 GB."
  elif [ "$free_kb" -lt 15728640 ]; then
    if [ "$existing" = 1 ]; then
      note "Free disk space: about $free_gb GB. Yo is already installed, so this goes on, but keep 15 GB free."
    else
      block "Yo needs about 15 GB of free disk space where Docker keeps its data ($root); there are about $free_gb GB."
    fi
  else
    pass "Free disk space: about $free_gb GB"
  fi
  if [ "$BLOCKED" = 1 ]; then
    die "Yo can't be installed on this PC yet: see the STOP lines above." "Fix them, then run the same command again."
  fi

  # ---------------------------------------------------------------- Yo's files
  say ""
  say "Getting Yo $VERSION..."
  { mkdir -p "$APP_HOME" && chmod 700 "$APP_HOME"; } || die "Couldn't create $APP_HOME."
  local stage="$APP_HOME/.install"
  rm -rf "$stage" && mkdir -p "$stage"
  if [ -n "${YO_APP_SOURCE:-}" ]; then
    local compose="$YO_APP_SOURCE/yo-app-compose.yaml"
    [ -f "$compose" ] || compose="$YO_APP_SOURCE/compose.yaml"
    { cp "$compose" "$stage/compose.yaml" && cp "$YO_APP_SOURCE/yo-app" "$stage/yo-app"; } ||
      die "Couldn't copy Yo's files from $YO_APP_SOURCE."
  else
    local base="$RELEASES/v$VERSION"
    { curl -fsSL --retry 3 -o "$stage/compose.yaml" "$base/yo-app-compose.yaml" &&
      curl -fsSL --retry 3 -o "$stage/yo-app" "$base/yo-app"; } ||
      die "Couldn't download Yo's files from $base." "Check this PC's internet connection and run the installer again."
  fi
  chmod 755 "$stage/yo-app"
  mv -f "$stage/compose.yaml" "$APP_HOME/compose.yaml"
  mv -f "$stage/yo-app" "$APP_HOME/yo-app"
  rm -rf "$stage"
  pass "Files in $APP_HOME"

  # ---------------------------------------------------------------- settings
  local project token port tz
  project="${YO_APP_PROJECT:-$(env_get YO_APP_PROJECT)}"
  project="${project:-yo-app}"
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "YO_APP_PROJECT must be lowercase letters, digits, - or _."
  dcp() { (cd "$APP_HOME" && docker compose --project-name "$project" -f compose.yaml --env-file .env "$@"); }

  token="$(env_get YO_AGENTD_TOKEN)"
  if [[ ! "$token" =~ ^[0-9a-f]{64}$ ]]; then
    token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    [ "${#token}" -eq 64 ] || die "Couldn't make a secret (no /dev/urandom?)."
  fi

  # The port: the one Yo already has (if it's running there or the port is still free), else 7777 or the next
  # free one up to 7799.
  local ours_running=0
  if [ "$existing" = 1 ] && [ -f "$APP_HOME/compose.yaml" ] && [ -n "$(dcp ps -q --status running yo-core 2>/dev/null)" ]; then
    ours_running=1
  fi
  port=""
  local want="${YO_APP_PORT:-$(env_get YO_PORT)}"
  want="${want:-7777}"
  [[ "$want" =~ ^[0-9]+$ ]] || die "YO_APP_PORT must be a number."
  local current
  current="$(env_get YO_PORT)"
  if [ "$ours_running" = 1 ] && [ "$want" = "$current" ]; then
    port="$want"
  else
    local p last=7799
    [ "$want" -gt "$last" ] && last="$want"
    for ((p = want; p <= last; p++)); do
      if port_free "$p"; then
        port="$p"
        break
      fi
    done
    if [ -z "$port" ]; then
      if [ "$want" = "$last" ]; then
        die "Port $want is in use by another program on this PC, so Yo has nowhere to listen." "Close that program (or choose another port with YO_APP_PORT), then run the installer again."
      fi
      die "Ports $want to $last are all in use on this PC, so Yo has nowhere to listen." "Close a program that uses one of them, then run the installer again."
    fi
    [ "$port" = "$want" ] || note "Port $want is used by another program, so Yo uses port $port."
  fi

  tz=""
  command -v timedatectl >/dev/null 2>&1 && tz="$(timedatectl show -p Timezone --value 2>/dev/null)"
  [ -z "$tz" ] && [ -r /etc/timezone ] && tz="$(head -n 1 /etc/timezone)"
  [ -z "$tz" ] && [ -L /etc/localtime ] && tz="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
  if [[ ! "$tz" =~ ^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$ ]]; then
    tz="UTC"
    note "Couldn't tell this PC's time zone, so Yo uses UTC. Change YO_TZ in $ENV_FILE (like Europe/Lisbon), then: yo-app restart"
  fi

  if [ ! -f "$ENV_FILE" ]; then (umask 077 && : >"$ENV_FILE"); fi
  env_set YO_AGENTD_TOKEN "$token"
  env_set YO_APP_PROJECT "$project"
  env_set YO_PORT "$port"
  env_set YO_TZ "$tz"
  env_set YO_COMPUTER_MEMORY "$memory_limit"
  env_set YO_CORE_IMAGE "${YO_CORE_IMAGE:-$CORE_REPO:$VERSION}"
  env_set YO_COMPUTER_IMAGE "${YO_COMPUTER_IMAGE:-$COMPUTER_REPO:$VERSION}"
  env_set YO_VERSION "$VERSION"
  env_set YO_APP_LINK "$BIN_DIR/yo-app"
  chmod 600 "$ENV_FILE"
  pass "Settings in $ENV_FILE (private): port $port, time zone $tz, computer memory $memory_limit"

  # The helper on PATH.
  { mkdir -p "$BIN_DIR" && ln -sfn "$APP_HOME/yo-app" "$BIN_DIR/yo-app"; } || die "Couldn't create $BIN_DIR/yo-app."
  local on_path=0
  case ":$PATH:" in *":$BIN_DIR:"*) on_path=1 ;; esac
  pass "The yo-app command: $BIN_DIR/yo-app"

  # ---------------------------------------------------------------- images and start
  if [ "${YO_APP_SKIP_PULL:-}" != 1 ]; then
    say ""
    say "Downloading Yo (about 1 GB the first time; this can take a few minutes)..."
    dcp pull || die "Couldn't download Yo's images." \
      "Check this PC's internet connection and run the installer again. (If this is a brand-new release, its" \
      "images may not be public yet: wait a few minutes and try again.)"
  fi
  say ""
  YO_APP_HOME="$APP_HOME" "$APP_HOME/yo-app" start ||
    die "Yo is installed but didn't start (the messages above say why)." "Try again with:  $BIN_DIR/yo-app open"

  local cmd="yo-app"
  [ "$on_path" = 1 ] || cmd="$BIN_DIR/yo-app"
  say ""
  say "Yo is installed."
  say ""
  say "  Yo lives in:   $APP_HOME (your chats and files are in Docker volumes ${project}_core-data and ${project}_computer-data)"
  say "  Open Yo:       $cmd open     (or http://127.0.0.1:$port once this browser is signed in)"
  say "  Yo keeps running in the background with Docker, also with the browser closed, and starts again with"
  say "  Docker when this PC restarts."
  say ""
  say "  $cmd open        open Yo in your browser and sign it in"
  say "  $cmd signin      a one-time sign-in link for another browser"
  say "  $cmd status      is Yo running?"
  say "  $cmd stop | start | restart"
  say "  $cmd update      get the newest Yo"
  say "  $cmd logs        Yo's recent messages, for bug reports"
  say "  $cmd uninstall   remove Yo"
  say "  $cmd help        everything else"
  if [ "$on_path" = 0 ]; then
    say ""
    if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
      say "  (To type just 'yo-app', open a new terminal: most Linux systems add ~/.local/bin to the PATH at login.)"
    else
      say "  (To type just 'yo-app', add $BIN_DIR to your PATH.)"
    fi
  fi
  YO_APP_HOME="$APP_HOME" "$APP_HOME/yo-app" signin ||
    die "Yo is running, but the sign-in link failed. Try:  $cmd signin"
}

main "$@"
